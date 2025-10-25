const express = require('express');
const cors = require('cors');
const https = require('https');

// Configuration
const CONFIG = {
    PORT: process.env.PORT || 3000,
    DEEPSEEK_API_BASE: 'https://api.deepseek.com',
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    AVAILABLE_MODELS: [
        'deepseek-chat',
        'deepseek-reasoner',
        'deepseek-coder'
    ]
};

if (!CONFIG.DEEPSEEK_API_KEY) {
    console.error('❌ ERROR: DEEPSEEK_API_KEY environment variable is required');
    process.exit(1);
}

const app = express();

// Enhanced CORS for Java client
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: '*',
    exposedHeaders: '*'
}));

app.use(express.json({ limit: '50mb' }));

// Enhanced logging middleware
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`📥 [${timestamp}] ${req.method} ${req.path}`, {
        ip: req.ip,
        'user-agent': req.get('User-Agent'),
        'content-type': req.get('Content-Type'),
        'content-length': req.get('Content-Length'),
        stream: req.body?.stream
    });
    
    // Log tools information for debugging
    if (req.body?.tools !== undefined) {
        console.log('🛠️ Tools in request:', {
            has_tools: !!req.body.tools,
            tools_length: req.body.tools?.length || 0,
            tools_type: typeof req.body.tools
        });
    }
    
    next();
});

// Custom HTTPS agent
const httpsAgent = new https.Agent({
    keepAlive: false,
    maxSockets: 50,
    timeout: 120000
});

// Clean request data by removing empty tools arrays
function cleanRequestData(requestData) {
    const cleaned = { ...requestData };
    
    // Remove empty tools array to avoid DeepSeek API errors
    if (cleaned.tools && Array.isArray(cleaned.tools) && cleaned.tools.length === 0) {
        console.log('🔧 Removing empty tools array from request');
        delete cleaned.tools;
    }
    
    // Also remove tool_choice if tools were removed
    if (cleaned.tool_choice && !cleaned.tools) {
        console.log('🔧 Removing tool_choice since tools were removed');
        delete cleaned.tool_choice;
    }
    
    // Remove any other problematic fields that might cause 400 errors
    const fieldsToCheck = ['functions', 'function_call', 'tools', 'tool_choice'];
    fieldsToCheck.forEach(field => {
        if (cleaned[field] !== undefined && 
            ((Array.isArray(cleaned[field]) && cleaned[field].length === 0) || cleaned[field] === null)) {
            console.log(`🔧 Removing empty/null ${field} from request`);
            delete cleaned[field];
        }
    });
    
    return cleaned;
}

// Non-streaming request function
function makeDeepSeekNonStreamingRequest(path, data) {
    return new Promise((resolve, reject) => {
        const cleanedData = cleanRequestData(data);
        const postData = JSON.stringify(cleanedData);
        
        const options = {
            hostname: 'api.deepseek.com',
            port: 443,
            path: path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CONFIG.DEEPSEEK_API_KEY}`,
                'Content-Length': Buffer.byteLength(postData),
                'User-Agent': 'DeepSeek-Proxy/1.0'
            },
            agent: httpsAgent,
            timeout: 60000
        };

        const req = https.request(options, (res) => {
            let responseData = '';

            res.on('data', (chunk) => {
                responseData += chunk;
            });

            res.on('end', () => {
                try {
                    const parsed = JSON.parse(responseData);
                    resolve(parsed);
                } catch (e) {
                    reject(new Error(`Failed to parse response: ${e.message}`));
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        req.write(postData);
        req.end();
    });
}

// Fixed streaming handler with tools cleaning
function handleDeepSeekStreaming(req, res, requestData) {
    return new Promise((resolve, reject) => {
        // Clean the request data first
        const cleanedData = cleanRequestData(requestData);
        const postData = JSON.stringify(cleanedData);
        const requestId = Math.random().toString(36).substring(2, 15);
        
        console.log('🔀 Sending to DeepSeek:', {
            model: cleanedData.model,
            stream: true,
            message_count: cleanedData.messages?.length,
            request_id: requestId,
            has_tools: !!cleanedData.tools,
            tools_count: cleanedData.tools?.length || 0
        });

        const options = {
            hostname: 'api.deepseek.com',
            port: 443,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CONFIG.DEEPSEEK_API_KEY}`,
                'Content-Length': Buffer.byteLength(postData),
                'User-Agent': 'DeepSeek-Proxy/1.0',
                'Accept': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'close'
            },
            agent: httpsAgent,
            timeout: 120000
        };

        // Set SSE headers immediately
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': '*',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Expose-Headers': '*',
            'X-Accel-Buffering': 'no'
        });

        const deepSeekReq = https.request(options, (deepSeekRes) => {
            console.log(`✅ DeepSeek Response: ${deepSeekRes.statusCode}`);
            
            if (deepSeekRes.statusCode !== 200) {
                let errorData = '';
                deepSeekRes.on('data', (chunk) => errorData += chunk);
                deepSeekRes.on('end', () => {
                    console.error('❌ DeepSeek API Error:', {
                        status: deepSeekRes.statusCode,
                        error: errorData
                    });
                    
                    // Send error as SSE if streaming was expected
                    res.write(`data: ${JSON.stringify({
                        error: {
                            message: `DeepSeek API error: ${deepSeekRes.statusCode} - ${errorData}`,
                            type: 'api_error'
                        }
                    })}\n\n`);
                    res.end();
                    reject(new Error(`API error: ${deepSeekRes.statusCode}`));
                });
                return;
            }

            let buffer = '';
            const startTime = Date.now();
            let tokenCount = 0;

            // Initialize model response logging
            console.log(`\n🤖 ${cleanedData.model} Response:`);
            console.log('─'.repeat(80));

            deepSeekRes.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.trim() === '') continue;
                    
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        
                        if (data === '[DONE]') {
                            // Send proper SSE termination
                            res.write('data: [DONE]\n\n');
                            console.log('\n─'.repeat(80));
                            console.log(`📊 Statistics:`);
                            console.log(`   Model: ${cleanedData.model}`);
                            console.log(`   Duration: ${Date.now() - startTime}ms`);
                            console.log(`   Estimated tokens: ${tokenCount}`);
                            console.log(`   Request ID: ${requestId}`);
                            return;
                        }

                        try {
                            const parsed = JSON.parse(data);
                            
                            // Log model response content in real-time
                            if (parsed.choices?.[0]?.delta?.content) {
                                const content = parsed.choices[0].delta.content;
                                tokenCount++;
                                process.stdout.write(content);
                            }

                            // Forward the exact DeepSeek response to client
                            res.write(`data: ${data}\n\n`);
                            
                        } catch (e) {
                            // Ignore parse errors for empty lines
                        }
                    } else {
                        // If it's not properly formatted as SSE, format it
                        res.write(`data: ${line}\n\n`);
                    }
                }
            });

            deepSeekRes.on('end', () => {
                // Process any remaining buffer
                if (buffer.trim()) {
                    if (buffer.startsWith('data: ')) {
                        res.write(buffer + '\n\n');
                    } else {
                        res.write(`data: ${buffer}\n\n`);
                    }
                }
                
                // Ensure [DONE] is sent
                res.write('data: [DONE]\n\n');
                res.end();
                
                console.log('\n─'.repeat(80));
                console.log(`📊 Stream completed - Duration: ${Date.now() - startTime}ms, Tokens: ${tokenCount}`);
                resolve();
            });

            deepSeekRes.on('error', (error) => {
                console.error('❌ DeepSeek stream error:', error);
                res.write(`data: ${JSON.stringify({
                    error: {
                        message: `Stream error: ${error.message}`,
                        type: 'stream_error'
                    }
                })}\n\n`);
                res.end();
                reject(error);
            });
        });

        deepSeekReq.on('error', (error) => {
            console.error('❌ Request to DeepSeek failed:', error);
            res.write(`data: ${JSON.stringify({
                error: {
                    message: `Request failed: ${error.message}`,
                    type: 'request_error'
                }
            })}\n\n`);
            res.end();
            reject(error);
        });

        deepSeekReq.on('timeout', () => {
            console.error('❌ Request to DeepSeek timed out');
            deepSeekReq.destroy();
            res.write(`data: ${JSON.stringify({
                error: {
                    message: 'Request timeout',
                    type: 'timeout_error'
                }
            })}\n\n`);
            res.end();
            reject(new Error('Request timeout'));
        });

        deepSeekReq.write(postData);
        deepSeekReq.end();
    });
}

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        service: 'DeepSeek Proxy - Auto Tools Cleaner',
        timestamp: new Date().toISOString(),
        features: ['auto-tools-cleaning', 'streaming', 'java-client-support']
    });
});

// Models endpoint
app.get('/v1/models', (req, res) => {
    const models = CONFIG.AVAILABLE_MODELS.map((model, index) => ({
        id: model,
        object: 'model',
        created: Math.floor(Date.now() / 1000) - index,
        owned_by: 'deepseek'
    }));

    res.json({
        object: 'list',
        data: models
    });
});

// Main chat completions endpoint with automatic tools cleaning
app.post('/v1/chat/completions', async (req, res) => {
    try {
        const isStreaming = req.body.stream === true;
        
        console.log('🔀 Processing request:', {
            model: req.body.model,
            message_count: req.body.messages?.length,
            stream: isStreaming,
            original_tools_length: req.body.tools?.length || 0
        });

        if (isStreaming) {
            await handleDeepSeekStreaming(req, res, req.body);
        } else {
            const response = await makeDeepSeekNonStreamingRequest('/v1/chat/completions', req.body);
            
            // Log non-streaming response
            if (response.choices && response.choices[0].message) {
                console.log(`\n🤖 ${req.body.model} Response (Non-Streaming):`);
                console.log('─'.repeat(80));
                console.log(response.choices[0].message.content);
                console.log('─'.repeat(80));
                if (response.usage) {
                    console.log(`📊 Usage: ${response.usage.total_tokens} tokens`);
                }
            }
            
            res.json(response);
        }
        
    } catch (error) {
        console.error('❌ Proxy error:', error.message);
        if (!res.headersSent) {
            res.status(500).json({
                error: {
                    message: `Proxy error: ${error.message}`,
                    type: 'proxy_error'
                }
            });
        }
    }
});

// Handle preflight
app.options('*', (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', '*');
    res.header('Access-Control-Allow-Headers', '*');
    res.status(204).send();
});

// 404 handler
app.use('*', (req, res) => {
    console.log(`❓ 404 - Endpoint not found: ${req.method} ${req.originalUrl}`);
    res.status(404).json({
        error: {
            message: `Endpoint ${req.method} ${req.originalUrl} not found`,
            type: 'invalid_request_error'
        }
    });
});

// Start server
app.listen(CONFIG.PORT, '0.0.0.0', () => {
    console.log(`
🎯 DeepSeek Proxy (Auto Tools Cleaner)
──────────────────────────────────────
📍 Local: http://localhost:${CONFIG.PORT}
🔑 API Key: ${CONFIG.DEEPSEEK_API_KEY ? '✅ Set' : '❌ Missing'}

🛠️ Automatic Fixes:
   • Removes empty tools arrays to prevent 400 errors
   • Cleans tool_choice when tools are removed
   • Handles both streaming and non-streaming requests
   • Comprehensive error logging

✨ Ready for JetBrains AI Assistant!
    `);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');
    process.exit(0);
});
