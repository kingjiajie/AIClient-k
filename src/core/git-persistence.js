import { simpleGit } from 'simple-git';
import * as fs from 'fs';
import * as path from 'path';
import logger from '../utils/logger.js';

class GitPersistence {
    constructor() {
        this.git = null;
        this.enabled = false;
        this.initialized = false; // 防止重复初始化
        this.isProcessing = false;
        this.lastGC = 0;
        this.config = {
            url: process.env.GITSTORE_GIT_URL,
            user: process.env.GITSTORE_GIT_USERNAME || 'git',
            token: process.env.GITSTORE_GIT_TOKEN,
            branch: process.env.GITSTORE_GIT_BRANCH || 'main',
            localPath: process.env.GITSTORE_LOCAL_PATH || path.resolve(process.cwd(), 'gitstore')
        };

        // AIClient-k 需要持久化的核心路径（比 CPA 更多）
        this.persistPaths = [
            'configs',
            'auths',
            'plugins', // 包含插件配置、potluck 密钥、使用统计等
            'static/app/config' // 部分 UI 配置可能存放在此
        ];

        if (this.config.url && this.config.token) {
            this.enabled = true;
        }

        this.watchTimeout = null;
    }

    async initialize() {
        if (!this.enabled) return;

        // 防止重复初始化（配置重载时会再次调用）
        if (this.initialized) {
            logger.debug('[GitPersistence] Already initialized, skipping re-initialization');
            return;
        }

        try {
            logger.info(`[GitPersistence] Initializing Git persistence at ${this.config.localPath}`);
            
            const urlObj = new URL(this.config.url);
            urlObj.username = this.config.user;
            urlObj.password = this.config.token;
            const authenticatedUrl = urlObj.toString();

            if (!fs.existsSync(this.config.localPath)) {
                fs.mkdirSync(this.config.localPath, { recursive: true });
                logger.info(`[GitPersistence] Cloning repository...`);
                const git = simpleGit();
                await git.clone(authenticatedUrl, this.config.localPath, ['--depth', '1', '--branch', this.config.branch]).catch(async (err) => {
                    logger.warn(`[GitPersistence] Clone failed or empty repo, initializing: ${err.message}`);
                    const g = simpleGit(this.config.localPath);
                    await g.init();
                    await g.addRemote('origin', authenticatedUrl);
                    this.ensureGitKeep();
                });
            }

            this.git = simpleGit(this.config.localPath);
            await this.git.addConfig('user.name', 'AIClient-k Persistence');
            await this.git.addConfig('user.email', 'persistence@aiclient-k.local');

            logger.info(`[GitPersistence] Synchronizing from GitHub...`);
            await this.git.fetch('origin', this.config.branch).catch(() => {});
            await this.git.reset(['--hard', `origin/${this.config.branch}`]).catch(() => {
                logger.info('[GitPersistence] Remote branch not found, skipping reset.');
            });

            // 初始同步：云端 -> 本地
            this.syncToLocal();

            // 定时保存
            setInterval(() => this.save('Scheduled auto-sync'), 10 * 60 * 1000);
            this.setupWatcher();

            this.initialized = true; // 标记为已初始化
            logger.info(`[GitPersistence] Initialization complete.`);
        } catch (error) {
            logger.error(`[GitPersistence] Initialization failed: ${error.message}`);
            this.enabled = false;
        }
    }

    ensureGitKeep() {
        this.persistPaths.forEach(f => {
            const dir = path.join(this.config.localPath, f);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const keep = path.join(dir, '.gitkeep');
            if (!fs.existsSync(keep)) fs.writeFileSync(keep, '');
        });
    }

    syncToLocal() {
        logger.info('[GitPersistence] Syncing from Git storage to local...');
        for (const folder of this.persistPaths) {
            const src = path.join(this.config.localPath, folder);
            const dest = path.resolve(process.cwd(), folder);
            if (fs.existsSync(src)) {
                logger.debug(`[GitPersistence] Restoring ${folder} from Git...`);
                this.copyRecursiveSync(src, dest, true);
            }
        }
    }

    async save(message = 'Auto-sync persistence data') {
        if (!this.enabled || !this.git || this.isProcessing) return;
        this.isProcessing = true;

        try {
            let hasChanges = false;
            for (const folder of this.persistPaths) {
                const src = path.resolve(process.cwd(), folder);
                const dest = path.join(this.config.localPath, folder);
                
                if (fs.existsSync(src)) {
                    if (fs.existsSync(dest)) this.deleteFolderRecursive(dest);
                    fs.mkdirSync(dest, { recursive: true });
                    this.copyRecursiveSync(src, dest);
                    // 补回 .gitkeep
                    fs.writeFileSync(path.join(dest, '.gitkeep'), '');
                    hasChanges = true;
                }
            }

            if (hasChanges) {
                const status = await this.git.status();
                logger.debug(`[GitPersistence] Git status: ${status.files.length} files changed`);
                
                if (status.files.length > 0) {
                    logger.info(`[GitPersistence] Pushing updates to GitHub (Squash mode)... Changes: ${status.files.map(f => f.path).join(', ')}`);
                    
                    const tempBranch = `sync_${Date.now()}`;
                    await this.git.checkout(['--orphan', tempBranch]);
                    await this.git.add('.');
                    await this.git.commit(message);
                    await this.git.push(['-f', 'origin', `${tempBranch}:${this.config.branch}`]);
                    
                    await this.git.checkout(this.config.branch).catch(() => {});
                    await this.git.reset(['--hard', tempBranch]);
                    await this.git.branch(['-D', tempBranch]);

                    logger.info(`[GitPersistence] Persistence sync complete.`);
                    this.maybeGC();
                }
            }
        } catch (error) {
            logger.error(`[GitPersistence] Save failed: ${error.message}`);
        } finally {
            this.isProcessing = false;
        }
    }

    async maybeGC() {
        const now = Date.now();
        if (now - this.lastGC > 60 * 60 * 1000) {
            try {
                await this.git.raw(['gc', '--prune=now', '--aggressive']);
                this.lastGC = now;
            } catch (e) {}
        }
    }

    copyRecursiveSync(src, dest, overwrite = true) {
        if (!fs.existsSync(src)) return;
        const stats = fs.statSync(src);
        if (stats.isDirectory()) {
            if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
            fs.readdirSync(src).forEach(child => {
                if (child === '.git') return;
                // 排除一些不需要持久化的子目录，如插件的 node_modules
                if (child === 'node_modules') return;
                this.copyRecursiveSync(path.join(src, child), path.join(dest, child), overwrite);
            });
        } else {
            // 只持久化配置类文件，排除日志和临时文件
            const ext = path.extname(src).toLowerCase();
            const filename = path.basename(src).toLowerCase();
            if (filename.startsWith('.') && filename !== '.gitkeep') return;
            if (filename.endsWith('.log') || filename.endsWith('.tmp') || filename.endsWith('.bak')) return;
            // 只同步 JSON, YAML, TXT, JS(部分配置用js)
            const allowedExts = ['.json', '.yaml', '.yml', '.txt', '.js', '.gitkeep'];
            if (!allowedExts.includes(ext)) return;

            let shouldCopy = true;
            if (fs.existsSync(dest)) {
                const sBuf = fs.readFileSync(src);
                const dBuf = fs.readFileSync(dest);
                if (sBuf.equals(dBuf)) shouldCopy = false;
            }
            if (shouldCopy && (overwrite || !fs.existsSync(dest))) {
                fs.copyFileSync(src, dest);
            }
        }
    }

    deleteFolderRecursive(folderPath) {
        if (fs.existsSync(folderPath)) {
            fs.readdirSync(folderPath).forEach((file) => {
                const curPath = path.join(folderPath, file);
                if (fs.lstatSync(curPath).isDirectory()) {
                    this.deleteFolderRecursive(curPath);
                } else {
                    fs.unlinkSync(curPath);
                }
            });
            fs.rmdirSync(folderPath);
        }
    }

    setupWatcher() {
        this.persistPaths.forEach(dir => {
            const fullPath = path.resolve(process.cwd(), dir);
            if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true });
            fs.watch(fullPath, { recursive: true }, (eventType, filename) => {
                if (filename) {
                    const ext = path.extname(filename).toLowerCase();
                    const allowedExts = ['.json', '.yaml', '.yml', '.txt', '.js'];
                    if (allowedExts.includes(ext) && !filename.startsWith('.') && !filename.endsWith('.tmp')) {
                        this.debounceSave();
                    }
                }
            });
        });
    }

    debounceSave() {
        if (this.watchTimeout) clearTimeout(this.watchTimeout);
        this.watchTimeout = setTimeout(() => this.save('File system change sync'), 30000);
    }
}

export const gitPersistence = new GitPersistence();
export default gitPersistence;
