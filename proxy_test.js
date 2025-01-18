const http = require('http');

async function testProxy() {
    const options = {
        host: 'localhost',
        port: 8080,
        path: 'http://example.com/',
        method: 'GET'
    };

    // First request
    console.time('First Request');
    await makeRequest(options);
    console.timeEnd('First Request');

    // Second request (cached)
    console.time('Second Request');
    await makeRequest(options);
    console.timeEnd('Second Request');
}

function makeRequest(options) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
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


testProxy().catch(console.error);