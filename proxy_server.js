const http = require('http');
const net = require('net');
const url = require('url');
const { performance } = require('perf_hooks');
const EventEmitter = require('events');

// Constants
const CONFIG = {
  MAX_BYTES: 4096,
  MAX_CLIENTS: 400,
  MAX_CACHE_SIZE: 200 * (1 << 20), // 200 MB
  MAX_ELEMENT_SIZE: 10 * (1 << 20), // 10 MB
  DEFAULT_PORT: 8080,
  REQUEST_TIMEOUT: 5000, // 5 seconds
  MAX_RETRIES: 3
};

// Custom Error Class
class ProxyError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'ProxyError';
    this.statusCode = statusCode;
  }
}

// Cache Element
class CacheElement {
  constructor(data, url) {
    this.data = data;
    this.url = url;
    this.timestamp = performance.now();
    this.hits = 0;
    this.lastAccessed = Date.now();
    this.size = Buffer.byteLength(data) + Buffer.byteLength(url);
  }

  updateAccess() {
    this.hits++;
    this.lastAccessed = Date.now();
    this.timestamp = performance.now();
  }
}

// LRU Cache
class LRUCache extends EventEmitter {
  constructor(maxSize) {
    super();
    this.maxSize = maxSize;
    this.currentSize = 0;
    this.cacheMap = new Map();

    // Periodic cache cleanup
    setInterval(() => this.cleanupCache(), 1800000); // 30 minutes
  }

  find(url) {
    const element = this.cacheMap.get(url);
    if (element) {
      element.updateAccess();
      this.emit('cacheHit', url);
      return element;
    }
    this.emit('cacheMiss', url);
    return null;
  }

  add(data, url) {
    try {
      const size = Buffer.byteLength(data) + Buffer.byteLength(url);

      if (size > CONFIG.MAX_ELEMENT_SIZE) {
        this.emit('cacheError', new Error(`Content too large for cache: ${size} bytes`));
        return false;
      }

      while (this.currentSize + size > this.maxSize) {
        this.removeOldest();
      }

      const newElement = new CacheElement(data, url);
      this.cacheMap.set(url, newElement);
      this.currentSize += size;

      this.emit('cacheAdd', url);
      return true;
    } catch (error) {
      this.emit('cacheError', error);
      return false;
    }
  }

  removeOldest() {
    if (this.cacheMap.size === 0) return;

    let oldestKey = null;
    let oldestTime = Infinity;

    for (const [key, element] of this.cacheMap.entries()) {
      if (element.lastAccessed < oldestTime) {
        oldestTime = element.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const element = this.cacheMap.get(oldestKey);
      this.currentSize -= element.size;
      this.cacheMap.delete(oldestKey);
      this.emit('cacheRemove', oldestKey);
    }
  }

  cleanupCache() {
    const now = Date.now();
    const expiryTime = 3600000; // 1 hour

    for (const [key, element] of this.cacheMap.entries()) {
      if (now - element.lastAccessed > expiryTime) {
        this.currentSize -= element.size;
        this.cacheMap.delete(key);
        this.emit('cacheExpire', key);
      }
    }
  }
}

// Semaphore
class Semaphore {
  constructor(max) {
    this.max = max;
    this.count = 0;
    this.queue = [];
  }

  async acquire(timeout = CONFIG.REQUEST_TIMEOUT) {
    if (this.count < this.max) {
      this.count++;
      return true;
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const index = this.queue.indexOf(resolve);
        if (index > -1) {
          this.queue.splice(index, 1);
        }
        reject(new ProxyError('Connection limit reached', 503));
      }, timeout);

      this.queue.push(() => {
        clearTimeout(timeoutId);
        resolve(true);
      });
    });
  }

  release() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next();
    } else {
      this.count--;
    }
  }
}

// Request Handler
class RequestHandler {
  constructor(request, response) {
    this.request = request;
    this.response = response;
    this.retries = 0;
  }

  async handleRequest() {
    const parsedUrl = url.parse(this.request.url);

    try {
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 80,
        path: parsedUrl.path,
        method: this.request.method,
        headers: { ...this.request.headers }
      };

      return await this.makeRequest(options);
    } catch (error) {
      throw new ProxyError(error.message, 502);
    }
  }

  async makeRequest(options, retryCount = 0) {
    return new Promise((resolve, reject) => {
      const proxyReq = http.request(options, (proxyRes) => {
        let responseData = Buffer.from('');
        let totalSize = 0;

        proxyRes.setTimeout(CONFIG.REQUEST_TIMEOUT);

        proxyRes.on('data', (chunk) => {
          totalSize += chunk.length;
          if (totalSize > CONFIG.MAX_BYTES) {
            proxyReq.destroy();
            reject(new ProxyError('Response too large', 413));
            return;
          }
          responseData = Buffer.concat([responseData, chunk]);
        });

        proxyRes.on('timeout', () => {
          proxyReq.destroy();
          reject(new ProxyError('Response timeout', 504));
        });

        proxyRes.on('end', () => {
          resolve({
            statusCode: proxyRes.statusCode,
            headers: proxyRes.headers,
            data: responseData
          });
        });
      });

      proxyReq.setTimeout(CONFIG.REQUEST_TIMEOUT);

      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        reject(new ProxyError('Request timeout', 504));
      });

      proxyReq.on('error', (error) => {
        if (retryCount < CONFIG.MAX_RETRIES) {
          setTimeout(() => {
            resolve(this.makeRequest(options, retryCount + 1));
          }, 1000 * (retryCount + 1));
        } else {
          reject(error);
        }
      });

      proxyReq.end();
    });
  }
}

// Proxy Server
class ProxyServer {
  constructor(port = CONFIG.DEFAULT_PORT) {
    this.port = port;
    this.cache = new LRUCache(CONFIG.MAX_CACHE_SIZE);
    this.semaphore = new Semaphore(CONFIG.MAX_CLIENTS);
    this.setupCacheEvents();
  }

  setupCacheEvents() {
    this.cache.on('cacheHit', (url) => console.log(`Cache hit: ${url}`));
    this.cache.on('cacheMiss', (url) => console.log(`Cache miss: ${url}`));
    this.cache.on('cacheError', (error) => console.error(`Cache error: ${error.message}`));
  }

  async handleRequest(req, res) {
    try {
      await this.semaphore.acquire();

      const cacheKey = `${req.method} ${req.url}`;
      const cachedResponse = this.cache.find(cacheKey);

      if (cachedResponse) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(cachedResponse.data);
        return;
      }

      const handler = new RequestHandler(req, res);
      const response = await handler.handleRequest();

      if (response.statusCode === 200) {
        this.cache.add(response.data, cacheKey);
      }

      res.writeHead(response.statusCode, response.headers);
      res.end(response.data);

    } catch (error) {
      const statusCode = error.statusCode || 500;
      res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
      res.end(`Error: ${error.message}`);
    } finally {
      this.semaphore.release();
    }
  }

  handleHttpsTunnel(clientSocket, targetUrl) {
    const [host, port = '443'] = targetUrl.split(':');

    const serverSocket = net.connect(parseInt(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on('error', () => clientSocket.end());
    clientSocket.on('error', () => serverSocket.end());

    clientSocket.setTimeout(CONFIG.REQUEST_TIMEOUT);
    serverSocket.setTimeout(CONFIG.REQUEST_TIMEOUT);

    clientSocket.on('timeout', () => {
      clientSocket.destroy();
      serverSocket.destroy();
    });

    serverSocket.on('timeout', () => {
      clientSocket.destroy();
      serverSocket.destroy();
    });
  }

  start() {
    // HTTP Server
    const httpServer = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    // TCP Server for HTTPS tunneling
    const tcpServer = net.createServer((clientSocket) => {
      clientSocket.once('data', (data) => {
        const firstLine = data.toString().split('\r\n')[0];
        const [method, url] = firstLine.split(' ');

        if (method === 'CONNECT') {
          this.handleHttpsTunnel(clientSocket, url);
        } else {
          clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        }
      });
    });

    // Start servers
    httpServer.listen(this.port, () => {
      console.log(`HTTP proxy server listening on port ${this.port}`);
      console.log(`Cache size: ${CONFIG.MAX_CACHE_SIZE / (1024 * 1024)}MB`);
    });

    tcpServer.listen(this.port + 1, () => {
      console.log(`HTTPS tunnel listening on port ${this.port + 1}`);
    });

    // Error handling
    httpServer.on('error', (error) => {
      console.error('HTTP Server error:', error);
    });

    tcpServer.on('error', (error) => {
      console.error('TCP Server error:', error);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => {
      console.log('Shutting down servers...');
      httpServer.close();
      tcpServer.close();
      process.exit(0);
    });
  }
}

// Start the server
const server = new ProxyServer(CONFIG.DEFAULT_PORT);
server.start();