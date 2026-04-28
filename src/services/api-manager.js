import {
    handleModelListRequest,
    handleContentGenerationRequest,
    API_ACTIONS,
    ENDPOINT_TYPE,
    getRequestBody,
    getRateLimitCooldownRecoveryTime
} from '../utils/common.js';
import { getProviderPoolManager, getApiServiceWithFallback } from './service-manager.js';
import logger from '../utils/logger.js';
import busboy from 'busboy';
import { IMAGE_MODELS as SUPPORTED_IMAGE_MODELS } from '../providers/openai/codex-core.js';

const IMAGE_GEN_MAX_N = 4;
const VALID_RESPONSE_FORMATS = new Set(['b64_json', 'url']);

/**
 * Handle API authentication and routing
 * @param {string} method - The HTTP method
 * @param {string} path - The request path
 * @param {http.IncomingMessage} req - The HTTP request object
 * @param {http.ServerResponse} res - The HTTP response object
 * @param {Object} currentConfig - The current configuration object
 * @param {Object} apiService - The API service instance
 * @param {Object} providerPoolManager - The provider pool manager instance
 * @param {string} promptLogFilename - The prompt log filename
 * @returns {Promise<boolean>} - True if the request was handled by API
 */
export async function handleAPIRequests(method, path, req, res, currentConfig, apiService, providerPoolManager, promptLogFilename) {


    // Route model list requests
    if (method === 'GET') {
        if (path === '/v1/models') {
            await handleModelListRequest(req, res, apiService, ENDPOINT_TYPE.OPENAI_MODEL_LIST, currentConfig, providerPoolManager, currentConfig.uuid);
            return true;
        }
        if (path === '/v1beta/models') {
            await handleModelListRequest(req, res, apiService, ENDPOINT_TYPE.GEMINI_MODEL_LIST, currentConfig, providerPoolManager, currentConfig.uuid);
            return true;
        }
    }

    // Route image generation/editing requests
    if (method === 'POST' && path === '/v1/images/generations') {
        await handleImageGenerationRequest(req, res, currentConfig, providerPoolManager);
        return true;
    }
    if (method === 'POST' && path === '/v1/images/edits') {
        await handleImageEditsRequest(req, res, currentConfig, providerPoolManager);
        return true;
    }

    // Route content generation requests
    if (method === 'POST') {
        if (path === '/v1/chat/completions') {
            await handleContentGenerationRequest(req, res, apiService, ENDPOINT_TYPE.OPENAI_CHAT, currentConfig, promptLogFilename, providerPoolManager, currentConfig.uuid, path);
            return true;
        }
        if (path === '/v1/responses') {
            await handleContentGenerationRequest(req, res, apiService, ENDPOINT_TYPE.OPENAI_RESPONSES, currentConfig, promptLogFilename, providerPoolManager, currentConfig.uuid, path);
            return true;
        }
        const geminiUrlPattern = new RegExp(`/v1beta/models/(.+?):(${API_ACTIONS.GENERATE_CONTENT}|${API_ACTIONS.STREAM_GENERATE_CONTENT})`);
        if (geminiUrlPattern.test(path)) {
            await handleContentGenerationRequest(req, res, apiService, ENDPOINT_TYPE.GEMINI_CONTENT, currentConfig, promptLogFilename, providerPoolManager, currentConfig.uuid, path);
            return true;
        }
        if (path === '/v1/messages') {
            await handleContentGenerationRequest(req, res, apiService, ENDPOINT_TYPE.CLAUDE_MESSAGE, currentConfig, promptLogFilename, providerPoolManager, currentConfig.uuid, path);
            return true;
        }
    }

    return false;
}

/**
 * Initialize API management features
 * @param {Object} services - The initialized services
 * @returns {Function} - The heartbeat and token refresh function
 */
export function initializeAPIManagement(services) {
    const providerPoolManager = getProviderPoolManager();
    return async function heartbeatAndRefreshToken() {
        logger.info(`[Heartbeat] Server is running. Current time: ${new Date().toLocaleString()}`, Object.keys(services));
        // 循环遍历所有已初始化的服务适配器，并尝试刷新令牌
        // if (getProviderPoolManager()) {
        //     await getProviderPoolManager().performInitialHealthChecks(); // 定期执行健康检查
        // }
        for (const providerKey in services) {
            const serviceAdapter = services[providerKey];
            try {
                // For pooled providers, refreshToken should be handled by individual instances
                // For single instances, this remains relevant
                if (serviceAdapter.config?.uuid && providerPoolManager) {
                    providerPoolManager._enqueueRefresh(serviceAdapter.config.MODEL_PROVIDER, {
                        config: serviceAdapter.config,
                        uuid: serviceAdapter.config.uuid
                    });
                } else {
                    await serviceAdapter.refreshToken();
                }
                // logger.info(`[Token Refresh] Refreshed token for ${providerKey}`);
            } catch (error) {
                logger.error(`[Token Refresh Error] Failed to refresh token for ${providerKey}: ${error.message}`);
                // 如果是号池中的某个实例刷新失败，这里需要捕获并更新其状态
                // 现有的 serviceInstances 存储的是每个配置对应的单例，而非池中的成员
                // 这意味着如果一个池成员的 token 刷新失败，需要找到它并更新其在 poolManager 中的状态
                // 暂时通过捕获错误日志来发现问题，更精细的控制需要在 refreshToken 中抛出更多信息
            }
        }
    };
}

/**
 * Handle POST /v1/images/generations - OpenAI 标准生图接口
 */
async function handleImageGenerationRequest(req, res, currentConfig, providerPoolManager, retryContext = null) {
    const IMAGE_GEN_MAX_N = 4;
    const VALID_RESPONSE_FORMATS = new Set(['b64_json', 'url']);

    const maxRetries = retryContext?.maxRetries ?? 3;
    const currentRetry = retryContext?.currentRetry ?? 0;
    const CONFIG = retryContext?.CONFIG ?? currentConfig;
    let slotProviderType = null;
    let slotUuid = null;
    let model, n, response_format, size, codexRequestBody;

    try {
        if (retryContext?.parsedBody) {
            ({model, n, response_format, size, codexRequestBody} = retryContext.parsedBody);
        } else {
            const body = await getRequestBody(req);
            model = body.model || 'gpt-image-2';
            response_format = body.response_format || 'b64_json';
            size = body.size;
            // cap n：至少 1，最多 IMAGE_GEN_MAX_N，非数字降级为 1
            n = Math.min(Math.max(1, parseInt(body.n) || 1), IMAGE_GEN_MAX_N);
            const prompt = body.prompt;

            if (!SUPPORTED_IMAGE_MODELS.has(model)) {
                res.writeHead(400, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({error: {message: `model '${model}' is not supported; supported image models: ${[...SUPPORTED_IMAGE_MODELS].join(', ')}`, type: 'invalid_request_error'}}));
                return;
            }

            if (!prompt) {
                res.writeHead(400, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({error: {message: 'prompt is required', type: 'invalid_request_error'}}));
                return;
            }

            if (!VALID_RESPONSE_FORMATS.has(response_format)) {
                res.writeHead(400, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({
                    error: {
                        message: `response_format must be 'b64_json' or 'url'`,
                        type: 'invalid_request_error'
                    }
                }));
                return;
            }

            // 构造 Codex 格式请求，prepareRequestBody 会自动处理 gpt-image-2 → gpt-5.4 + image_generation tool
            codexRequestBody = {
                model,
                input: [{
                    type: 'message',
                    role: 'user',
                    content: [{type: 'input_text', text: prompt}]
                }],
                ...(size ? {_imageSize: size} : {})
            };
        }

        // 从号池获取服务实例，acquireSlot 与其他接口保持一致
        const shouldUsePool = !!(providerPoolManager && CONFIG.providerPools);
        const result = await getApiServiceWithFallback(CONFIG, model, {acquireSlot: shouldUsePool});
        const service = result.service;

        if (!service) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'No service available for image generation', type: 'server_error' } }));
            return;
        }

        // 记录 slot 信息，供 finally 释放
        if (shouldUsePool && result.uuid) {
            slotProviderType = result.actualProviderType || CONFIG.MODEL_PROVIDER;
            slotUuid = result.uuid;
        }

        logger.info(`[Image Generation] model=${model}, n=${n}, response_format=${response_format}${size ? `, size=${size}` : ''}`);

        // 串行发起 n 张图请求，每张独立占用一次上游调用，与号池 slot 计数对应
        const data = [];
        for (let i = 0; i < n; i++) {
            const completedEvent = await service.generateContent(model, {...codexRequestBody});
            const output = completedEvent?.response?.output || [];
            for (const item of output) {
                if (item.type === 'image_generation_call' && item.result) {
                    const dataItem = response_format === 'url'
                        ? { url: `data:image/${item.output_format || 'png'};base64,${item.result}` }
                        : { b64_json: item.result };
                    if (item.revised_prompt) dataItem.revised_prompt = item.revised_prompt;
                    data.push(dataItem);
                }
            }
        }

        if (data.length === 0) {
            const rejectionText = extractRejectionMessage(completedEvents);
            if (rejectionText) {
                logger.warn(`[Image Generation] Content policy rejection: ${rejectionText.slice(0, 100)}`);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { code: 'content_policy_violation', message: rejectionText, type: 'invalid_request_error' } }));
            } else {
                logger.error('[Image Generation] No image found in response output');
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Image generation failed: no image in response', type: 'server_error' } }));
            }
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ created: Math.floor(Date.now() / 1000), data }));
    } catch (error) {
        logger.error('[Image Generation] Error:', error.message);

        const shouldSwitchCredential = error.shouldSwitchCredential === true;
        let credentialMarkedUnhealthy = error.credentialMarkedUnhealthy === true;

        if (providerPoolManager && slotUuid) {
            const rateLimitRecoveryTime = getRateLimitCooldownRecoveryTime(error, CONFIG);
            if (rateLimitRecoveryTime) {
                logger.info(`[Provider Pool] Applying 429 cooldown for ${slotProviderType} (${slotUuid})`);
                providerPoolManager.markProviderUnhealthyWithRecoveryTime(slotProviderType, {uuid: slotUuid}, '429 Too Many Requests - short cooldown', rateLimitRecoveryTime);
                credentialMarkedUnhealthy = true;
            } else if (!credentialMarkedUnhealthy && !error.skipErrorCount) {
                if (error.response?.status !== 400) {
                    logger.info(`[Provider Pool] Marking ${slotProviderType} as unhealthy due to image generation error (status: ${error.response?.status || 'unknown'})`);
                    providerPoolManager.markProviderUnhealthy(slotProviderType, {uuid: slotUuid}, error.message);
                    credentialMarkedUnhealthy = true;
                }
            }
        }

        if (shouldSwitchCredential && !credentialMarkedUnhealthy) {
            credentialMarkedUnhealthy = true;
        }

        if (credentialMarkedUnhealthy && currentRetry < maxRetries && providerPoolManager && CONFIG) {
            const randomDelay = Math.floor(Math.random() * 10000);
            logger.info(`[Image Generation Retry] Credential marked unhealthy. Waiting ${randomDelay}ms before retry ${currentRetry + 1}/${maxRetries}...`);
            await new Promise(resolve => setTimeout(resolve, randomDelay));

            try {
                return await handleImageGenerationRequest(req, res, CONFIG, providerPoolManager, {
                    ...retryContext,
                    CONFIG,
                    currentRetry: currentRetry + 1,
                    maxRetries,
                    parsedBody: {model, n, response_format, size, codexRequestBody}
                });
            } catch (retryError) {
                logger.error('[Image Generation Retry] Failed to get alternative service:', retryError.message);
            }
        }

        if (!res.writableEnded) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message, type: 'server_error' } }));
        }
    } finally {
        // 确保并发槽在请求结束后归还（与 handleStreamRequest/handleUnaryRequest 保持一致）
        if (providerPoolManager && slotProviderType && slotUuid) {
            providerPoolManager.releaseSlot(slotProviderType, slotUuid);
        }
    }
}

/**
 * Extract assistant rejection text from Codex output items.
 * Returns the text if a policy/safety rejection message is found, otherwise null.
 */
function extractRejectionMessage(completedEvents) {
    for (const completedEvent of completedEvents) {
        const output = completedEvent?.response?.output || [];
        for (const item of output) {
            if (item.type === 'message' && item.role === 'assistant') {
                const textPart = (item.content || []).find(c => c.type === 'output_text' && c.text);
                if (textPart?.text) return textPart.text;
            }
        }
    }
    return null;
}

/**
 * Parse multipart/form-data from a raw http.IncomingMessage via busboy.
 * Returns { fields: {key: string}, files: {key: {buffer, mimetype}} }
 * File buffers are collected in memory; mask field is accepted but ignored.
 */
function parseMultipartForm(req) {
    return new Promise((resolve, reject) => {
        const contentType = req.headers['content-type'] || '';
        if (!contentType.includes('multipart/form-data')) {
            return reject(new Error('Content-Type must be multipart/form-data'));
        }

        const bb = busboy({ headers: req.headers, limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB cap
        const fields = {};
        const files = {};

        let settled = false;
        const rejectOnce = (err) => {
            if (!settled) {
                settled = true;
                reject(err);
            }
        };
        const resolveOnce = (val) => {
            if (!settled) {
                settled = true;
                resolve(val);
            }
        };

        bb.on('field', (name, value) => { fields[name] = value; });

        bb.on('file', (name, stream, info) => {
            const chunks = [];
            stream.on('data', chunk => chunks.push(chunk));
            stream.on('end', () => { files[name] = { buffer: Buffer.concat(chunks), mimetype: info.mimeType }; });
            stream.on('error', rejectOnce);
        });

        bb.on('close', () => resolveOnce({fields, files}));
        bb.on('error', rejectOnce);

        // 客户端提前断连时 req 不会触发 'end'，需要主动拒绝，否则 Promise 永远挂起
        req.on('aborted', () => rejectOnce(new Error('Request aborted by client')));
        req.on('close', () => {
            if (!req.complete) {
                rejectOnce(new Error('Request connection closed before body was fully received'));
            }
        });

        req.pipe(bb);
    });
}

/**
 * Handle POST /v1/images/edits - OpenAI 标准改图接口
 * Accepts multipart/form-data: image (required), prompt (required),
 * mask (ignored), model, n, size, response_format
 */
async function handleImageEditsRequest(req, res, currentConfig, providerPoolManager) {
    let slotProviderType = null;
    let slotUuid = null;

    try {
        const { fields, files } = await parseMultipartForm(req);

        const model = fields.model || 'gpt-image-2';
        const prompt = fields.prompt;
        const response_format = fields.response_format || 'b64_json';
        const size = fields.size;
        const n = Math.min(Math.max(1, parseInt(fields.n) || 1), IMAGE_GEN_MAX_N);

        // 兼容 image[] 字段名（LiteLLM 发送的是 image[]，OpenAI 标准是 image）
        const imageFile = files.image || files['image[]'];

        logger.info(`[Image Edits] Received request: model=${model}, n=${n}, response_format=${response_format}, hasPrompt=${!!prompt}, hasImage=${!!imageFile}${size ? `, size=${size}` : ''}, fields=${JSON.stringify(Object.keys(fields))}, fileKeys=${JSON.stringify(Object.keys(files))}`);

        if (!SUPPORTED_IMAGE_MODELS.has(model)) {
            logger.warn(`[Image Edits] Unsupported model: ${model}`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `model '${model}' is not supported; supported image models: ${[...SUPPORTED_IMAGE_MODELS].join(', ')}`, type: 'invalid_request_error' } }));
            return;
        }

        if (!prompt) {
            logger.warn(`[Image Edits] Missing required field: prompt`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'prompt is required', type: 'invalid_request_error' } }));
            return;
        }

        if (!imageFile) {
            logger.warn(`[Image Edits] Missing required field: image (received file keys: ${JSON.stringify(Object.keys(files))})`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'image is required', type: 'invalid_request_error' } }));
            return;
        }

        if (!VALID_RESPONSE_FORMATS.has(response_format)) {
            logger.warn(`[Image Edits] Invalid response_format: ${response_format}`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `response_format must be 'b64_json' or 'url'`, type: 'invalid_request_error' } }));
            return;
        }

        const {buffer, mimetype} = imageFile;
        const imageUrl = `data:${mimetype || 'image/png'};base64,${buffer.toString('base64')}`;

        // 构造 Codex 请求：input_image + input_text，prepareRequestBody 自动处理 gpt-image-2 → gpt-5.4 + image_generation tool
        const codexRequestBody = {
            model,
            input: [{
                type: 'message',
                role: 'user',
                content: [
                    { type: 'input_image', image_url: imageUrl },
                    { type: 'input_text', text: prompt }
                ]
            }],
            ...(size ? { _imageSize: size } : {})
        };

        const shouldUsePool = !!(providerPoolManager && currentConfig.providerPools);
        const result = await getApiServiceWithFallback(currentConfig, model, { acquireSlot: shouldUsePool });
        const service = result.service;

        if (!service) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'No service available for image editing', type: 'server_error' } }));
            return;
        }

        if (shouldUsePool && result.uuid) {
            slotProviderType = result.actualProviderType || currentConfig.MODEL_PROVIDER;
            slotUuid = result.uuid;
        }

        logger.info(`[Image Edits] model=${model}, n=${n}, response_format=${response_format}, imageSize=${Math.round(buffer.length / 1024)}KB${size ? `, size=${size}` : ''}`);

        const imageRequests = Array.from({ length: n }, () =>
            service.generateContent(model, { ...codexRequestBody })
        );
        const completedEvents = await Promise.all(imageRequests);

        const data = [];
        for (const completedEvent of completedEvents) {
            const output = completedEvent?.response?.output || [];
            for (const item of output) {
                if (item.type === 'image_generation_call' && item.result) {
                    const dataItem = response_format === 'url'
                        ? { url: `data:image/${item.output_format || 'png'};base64,${item.result}` }
                        : { b64_json: item.result };
                    if (item.revised_prompt) dataItem.revised_prompt = item.revised_prompt;
                    data.push(dataItem);
                }
            }
        }

        if (data.length === 0) {
            const rejectionText = extractRejectionMessage(completedEvents);
            if (rejectionText) {
                logger.warn(`[Image Edits] Content policy rejection: ${rejectionText.slice(0, 100)}`);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { code: 'content_policy_violation', message: rejectionText, type: 'invalid_request_error' } }));
            } else {
                logger.error('[Image Edits] No image found in response output');
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Image editing failed: no image in response', type: 'server_error' } }));
            }
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ created: Math.floor(Date.now() / 1000), data }));
    } catch (error) {
        logger.error('[Image Edits] Error:', error.message);
        if (!res.writableEnded) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message, type: 'server_error' } }));
        }
    } finally {
        if (providerPoolManager && slotProviderType && slotUuid) {
            providerPoolManager.releaseSlot(slotProviderType, slotUuid);
        }
    }
}

/**
 * Helper function to read request body
 * @param {http.IncomingMessage} req The HTTP request object.
 * @returns {Promise<string>} The request body as string.
 */
export function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            resolve(body);
        });
        req.on('error', err => {
            reject(err);
        });
    });
}
