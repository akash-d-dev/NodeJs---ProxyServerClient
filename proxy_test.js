// const http = require('http');

// async function testProxy() {
//     const options = {
//         host: 'localhost',
//         port: 8080,
//         path: 'http://example.com/',
//         method: 'GET'
//     };

//     // First request
//     console.time('First Request');
//     await makeRequest(options);
//     console.timeEnd('First Request');

//     // Second request (cached)
//     console.time('Second Request');
//     await makeRequest(options);
//     console.timeEnd('Second Request');
// }

// function makeRequest(options) {
//     return new Promise((resolve, reject) => {
//         const req = http.request(options, (res) => {
//             let data = '';
//             res.on('data', (chunk) => data += chunk);
//             res.on('end', () => {
//                 console.log(`Response size: ${Buffer.byteLength(data)} bytes`);
//                 resolve(data);
//             });
//         });
//         req.on('error', reject);
//         req.end();
//     });
// }


// testProxy().catch(console.error);




// const http = require('http');
// const https = require('https');
// const assert = require('assert');
// const { performance } = require('perf_hooks');

// // Test server to simulate target server
// class TestServer {
//     constructor(port) {
//         this.server = http.createServer((req, res) => {
//             if (req.url === '/delay') {
//                 setTimeout(() => {
//                     res.writeHead(200);
//                     res.end('Delayed response');
//                 }, 1000);
//             } else if (req.url === '/large') {
//                 res.writeHead(200);
//                 res.end(Buffer.alloc(5 * 1024 * 1024)); // 5MB response
//             } else {
//                 res.writeHead(200);
//                 res.end('Hello from test server!');
//             }
//         });

//         this.server.listen(port);
//     }

//     close() {
//         this.server.close();
//     }
// }

// async function runTests() {
//     console.log('Starting proxy server tests...');

//     // Create test server
//     const testServer = new TestServer(9000);

//     try {
//         // Test 1: Basic HTTP Request
//         console.log('\nTest 1: Basic HTTP Request');
//         const basicResponse = await makeRequest('http://localhost:8080/http://localhost:9000');
//         assert.strictEqual(basicResponse, 'Hello from test server!');
//         console.log('✓ Basic HTTP request successful');

//         // Test 2: Caching
//         console.log('\nTest 2: Testing Cache');
//         const start = performance.now();
//         await makeRequest('http://localhost:8080/http://localhost:9000');
//         const firstRequest = performance.now() - start;

//         const cacheStart = performance.now();
//         await makeRequest('http://localhost:8080/http://localhost:9000');
//         const cachedRequest = performance.now() - cacheStart;

//         assert.ok(cachedRequest < firstRequest, 'Cached request should be faster');
//         console.log('✓ Cache is working (second request was faster)');

//         // Test 3: Large Response
//         console.log('\nTest 3: Testing Large Response');
//         try {
//             await makeRequest('http://localhost:8080/http://localhost:9000/large');
//             console.log('✗ Large response should have been rejected');
//         } catch (error) {
//             assert.ok(error.message.includes('413'));
//             console.log('✓ Large response properly rejected');
//         }

//         // Test 4: Timeout
//         console.log('\nTest 4: Testing Timeout');
//         try {
//             await makeRequest('http://localhost:8080/http://localhost:9000/delay', 500);
//             console.log('✗ Request should have timed out');
//         } catch (error) {
//             assert.ok(error.message.includes('504'));
//             console.log('✓ Timeout properly handled');
//         }

//         // Test 5: Concurrent Connections
//         console.log('\nTest 5: Testing Concurrent Connections');
//         const concurrentRequests = Array(500).fill().map(() =>
//             makeRequest('http://localhost:8080/http://localhost:9000')
//                 .catch(error => error)
//         );

//         const results = await Promise.all(concurrentRequests);
//         const failures = results.filter(r => r instanceof Error);
//         console.log(`✓ Concurrent test complete: ${failures.length} requests rejected due to connection limit`);

//     } catch (error) {
//         console.error('Test failed:', error);
//     } finally {
//         testServer.close();
//     }
// }

// // Helper function to make HTTP requests
// function makeRequest(url, timeout = 5000) {
//     return new Promise((resolve, reject) => {
//         const req = http.request(url, {
//             timeout: timeout
//         }, (res) => {
//             let data = '';
//             res.on('data', chunk => data += chunk);
//             res.on('end', () => {
//                 if (res.statusCode >= 400) {
//                     reject(new Error(`HTTP ${res.statusCode}`));
//                 } else {
//                     resolve(data);
//                 }
//             });
//         });

//         req.on('error', reject);
//         req.on('timeout', () => {
//             req.destroy();
//             reject(new Error('Request timed out'));
//         });

//         req.end();
//     });
// }

// // Run the tests
// runTests().catch(console.error);






const http = require('http');
const https = require('https');
const assert = require('assert');
const { performance } = require('perf_hooks');

// Test server to simulate target server
class TestServer {
    constructor(port) {
        this.server = http.createServer((req, res) => {
            if (req.url === '/delay') {
                setTimeout(() => {
                    res.writeHead(200);
                    res.end('Delayed response');
                }, 1000);
            } else if (req.url === '/large') {
                res.writeHead(200);
                res.end(Buffer.alloc(5 * 1024 * 1024)); // 5MB response
            } else {
                res.writeHead(200);
                res.end('Hello from test server!');
            }
        });

        this.server.listen(port);
    }

    close() {
        this.server.close();
    }
}

async function makeRequest(url) {
    return new Promise((resolve, reject) => {
        const req = http.request(url, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                console.log(`Response size: ${Buffer.byteLength(data)} bytes`);
                resolve(data);
            });
        });
        req.on('error', reject);
        req.end();
    });
}

async function runTests() {
    console.log('Starting proxy server tests...');

    // Create test server
    const testServer = new TestServer(9000);

    try {
        // Test 1: Basic HTTP Request
        console.log('\nTest 1: Basic HTTP Request');
        const basicResponse = await makeRequest('http://localhost:8080/http://localhost:9000');
        assert.strictEqual(basicResponse, 'Hello from test server!');
        console.log('✓ Basic HTTP request successful');

        // Test 2: Caching
        console.log('\nTest 2: Testing Cache');
        const start = performance.now();
        await makeRequest('http://localhost:8080/http://localhost:9000');
        const firstRequest = performance.now() - start;

        const cacheStart = performance.now();
        await makeRequest('http://localhost:8080/http://localhost:9000');
        const cachedRequest = performance.now() - cacheStart;

        assert.ok(cachedRequest < firstRequest, 'Cached request should be faster');
        console.log('✓ Cache is working (second request was faster)');

        // Test 3: Large Response
        console.log('\nTest 3: Testing Large Response');
        try {
            await makeRequest('http://localhost:8080/http://localhost:9000/large');
            console.log('✗ Large response should have been rejected');
        } catch (error) {
            assert.ok(error.message.includes('Response too large'), 'Expected error for large response');
            console.log('✓ Large response correctly rejected');
        }

        // Test 4: Delayed Response
        console.log('\nTest 4: Testing Delayed Response');
        const delayStart = performance.now();
        await makeRequest('http://localhost:8080/http://localhost:9000/delay');
        const delayDuration = performance.now() - delayStart;

        assert.ok(delayDuration >= 1000, 'Expected delayed response');
        console.log('✓ Delayed response handled correctly');

    } catch (error) {
        console.error('Test failed:', error);
    } finally {
        // Close test server
        testServer.close();
    }
}

// Run tests
runTests().catch(console.error);
