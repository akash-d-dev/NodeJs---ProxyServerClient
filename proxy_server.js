const http = require("http");
const net = require("net");
const url = require("url");

// Constants
const MAX_BYTES = 4096;
const MAX_CLIENTS = 400;
const MAX_CACHE_SIZE = 200 * (1 << 20);
const MAX_ELEMENT_SIZE = 10 * (1 << 20);

// Custom LinkedList implementation for Cache
class CacheElement {
  constructor(url, data, size) {
    this.url = url;
    this.data = data;
    this.size = size;
    this.lruTimeTrack = Date.now();
    this.next = null;
  }
}

class LRUCache {
  constructor() {
    this.head = null;
    this.currentSize = 0;
  }

  find(url) {
    let current = this.head;
    while (current) {
      if (current.url === url) {
        current.lruTimeTrack = Date.now();
        return current;
      }
      current = current.next;
    }
    return null;
  }

  removeOldest() {
    if (!this.head) return;

    let oldest = this.head;
    let prev = null;
    let current = this.head;

    while (current.next) {
      if (current.next.lruTimeTrack < oldest.lruTimeTrack) {
        oldest = current.next;
        prev = current;
      }
      current = current.next;
    }

    if (oldest === this.head) {
      this.head = this.head.next;
    } else {
      prev.next = oldest.next;
    }

    this.currentSize -= oldest.size;
    return oldest;
  }

  add(url, data, size) {
    if (size > MAX_ELEMENT_SIZE) return false;

    while (this.currentSize + size > MAX_CACHE_SIZE) {
      this.removeOldest();
    }

    const newElement = new CacheElement(url, data, size);
    newElement.next = this.head;
    this.head = newElement;
    this.currentSize += size;
    return true;
  }
}

// Semaphore implementation
class Semaphore {
  constructor(max) {
    this.max = max;
    this.count = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.count < this.max) {
      this.count++;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.queue.push(resolve);
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

// Mutex implementation
class Mutex {
  constructor() {
    this.locked = false;
    this.queue = [];
  }

  async lock() {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  unlock() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next();
    } else {
      this.locked = false;
    }
  }
}

// Initialize global objects
const cache = new LRUCache();
const semaphore = new Semaphore(MAX_CLIENTS);
const cacheMutex = new Mutex();

function sendErrorResponse(res, statusCode, isTcp = false) {
  const currentTime = new Date().toUTCString();
  const messages = {
    400: {
      title: "Bad Request",
      content:
        "<HTML><HEAD><TITLE>400 Bad Request</TITLE></HEAD>\n<BODY><H1>400 Bad Request</H1>\n</BODY></HTML>",
    },
    403: {
      title: "Forbidden",
      content:
        "<HTML><HEAD><TITLE>403 Forbidden</TITLE></HEAD>\n<BODY><H1>403 Forbidden</H1><br>Permission Denied\n</BODY></HTML>",
    },
    404: {
      title: "Not Found",
      content:
        "<HTML><HEAD><TITLE>404 Not Found</TITLE></HEAD>\n<BODY><H1>404 Not Found</H1>\n</BODY></HTML>",
    },
    500: {
      title: "Internal Server Error",
      content:
        "<HTML><HEAD><TITLE>500 Internal Server Error</TITLE></HEAD>\n<BODY><H1>500 Internal Server Error</H1>\n</BODY></HTML>",
    },
    501: {
      title: "Not Implemented",
      content:
        "<HTML><HEAD><TITLE>501 Not Implemented</TITLE></HEAD>\n<BODY><H1>501 Not Implemented</H1>\n</BODY></HTML>",
    },
    505: {
      title: "HTTP Version Not Supported",
      content:
        "<HTML><HEAD><TITLE>505 HTTP Version Not Supported</TITLE></HEAD>\n<BODY><H1>505 HTTP Version Not Supported</H1>\n</BODY></HTML>",
    },
  };

  const message = messages[statusCode];
  const headers = {
    "Content-Type": "text/html",
    Date: currentTime,
    Server: "NodeProxy/1.0",
    Connection: "close",
  };

  if (isTcp) {
    res.end(`${statusCode} ${message.title}\r\n`);
  } else {
    res.writeHead(statusCode, headers);
    res.end(message.content);
  }

  console.log(`${statusCode} ${message.title}`);
}

function checkHTTPVersion(version) {
  return version === "1.0" || version === "1.1";
}

function sanitizeUrl(requestUrl) {
  // Check if the URL has multiple protocol parts
  if (
    requestUrl.startsWith("http://http://") ||
    requestUrl.startsWith("https://https://")
  ) {
    // Fix the URL to have only one protocol
    requestUrl = requestUrl.replace(/^(http:\/\/|https:\/\/)+/, "$1");
  }
  return requestUrl;
}

async function handleRequest(req, res) {
  try {
    await semaphore.acquire();

    // Log the incoming URL request
    console.log(`Received HTTP request for: ${req.url}`);

    // Sanitize URL before processing
    const sanitizedUrl = sanitizeUrl(req.url);
    const requestUrl = url.parse(sanitizedUrl);

    let totalSize = 0;
    req.on("data", (chunk) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BYTES) {
        console.log("Request Entity Too Large", totalSize);
        sendErrorResponse(res, 400);
        req.destroy();
        return;
      }
    });

    if (req.method !== "GET") {
      console.log("Method Not Implemented", req.method);
      sendErrorResponse(res, 501);
      return;
    }

    if (!checkHTTPVersion(req.httpVersion)) {
      console.log("HTTP Version Not Supported", req.httpVersion);
      sendErrorResponse(res, 505);
      return;
    }

    // Check if the URL is valid
    if (!requestUrl.hostname || !requestUrl.protocol) {
      console.log("Invalid URL format");
      sendErrorResponse(res, 400); // Bad Request for invalid URL
      return;
    }

    // Check cache
    await cacheMutex.lock();
    const cachedResponse = cache.find(req.url);
    cacheMutex.unlock();

    if (cachedResponse) {
      console.log("Cache hit for:", req.url);
      res.writeHead(200, {
        "Content-Type": "text/html",
        Connection: "close",
      });
      res.end(cachedResponse.data);
      return;
    }

    // Forward request to remote server
    const options = {
      hostname: requestUrl.hostname,
      port: requestUrl.port || 80,
      path: requestUrl.path,
      method: "GET",
      headers: {
        ...req.headers,
        Connection: "close",
      },
    };

    const proxyRequest = http.request(options, async (proxyResponse) => {
      let responseData = Buffer.from("");

      proxyResponse.on("data", (chunk) => {
        responseData = Buffer.concat([responseData, chunk]);
      });

      proxyResponse.on("end", async () => {
        // Cache the response
        await cacheMutex.lock();
        cache.add(req.url, responseData, responseData.length);
        cacheMutex.unlock();

        res.writeHead(proxyResponse.statusCode, proxyResponse.headers);
        res.end(responseData);
      });
    });

    proxyRequest.on("error", (err) => {
      console.error("Proxy Request Error:", err);
      sendErrorResponse(res, 500);
    });

    proxyRequest.end();
  } catch (error) {
    console.error("Request Handler Error:", error);
    sendErrorResponse(res, 500);
  } finally {
    semaphore.release();
  }
}

// async function handleRequest(req, res) {
//   try {
//     await semaphore.acquire();

//     // Log the incoming URL request
//     console.log(`Received HTTP request for: ${req.url}`);

//     // Sanitize URL before processing
//     const sanitizedUrl = sanitizeUrl(req.url);
//     const requestUrl = url.parse(sanitizedUrl);

//     let totalSize = 0;
//     req.on("data", (chunk) => {
//       totalSize += chunk.length;
//       if (totalSize > MAX_BYTES) {
//         console.log("Request Entity Too Large");
//         sendErrorResponse(res, 400);
//         req.destroy();
//         return;
//       }
//     });

//     if (req.method !== "GET") {
//       console.log("Method Not Implemented");
//       sendErrorResponse(res, 501);
//       return;
//     }

//     if (!checkHTTPVersion(req.httpVersion)) {
//       console.log("HTTP Version Not Supported");
//       sendErrorResponse(res, 505);
//       return;
//     }

//     // Check if the URL is valid
//     if (!requestUrl.hostname || !requestUrl.protocol) {
//       console.log("Invalid URL format");
//       sendErrorResponse(res, 400); // Bad Request for invalid URL
//       return;
//     }

//     // Check cache
//     await cacheMutex.lock();
//     const cachedResponse = cache.find(req.url);
//     cacheMutex.unlock();

//     if (cachedResponse) {
//       console.log("Cache hit for:", req.url);
//       res.writeHead(200, {
//         "Content-Type": cachedResponse.contentType,
//         Connection: "close",
//       });
//       res.end(cachedResponse.data);
//       return;
//     }

//     // Forward request to remote server
//     const options = {
//       hostname: requestUrl.hostname,
//       port: requestUrl.port || 80,
//       path: requestUrl.path,
//       method: "GET",
//       headers: {
//         ...req.headers,
//         Connection: "close",
//       },
//     };

//     const proxyRequest = http.request(options, async (proxyResponse) => {
//       let responseData = Buffer.from("");
//       const contentType = proxyResponse.headers["content-type"] || "text/html";

//       // Cache the response if it's not an image or binary
//       proxyResponse.on("data", (chunk) => {
//         responseData = Buffer.concat([responseData, chunk]);
//       });

//       proxyResponse.on("end", async () => {
//         // Cache the response if the content type is suitable
//         if (contentType.startsWith("text/") || contentType === "application/json") {
//           await cacheMutex.lock();
//           cache.add(req.url, responseData, responseData.length, contentType);
//           cacheMutex.unlock();
//         }

//         res.writeHead(proxyResponse.statusCode, proxyResponse.headers);
//         res.end(responseData);
//       });
//     });

//     proxyRequest.on("error", (err) => {
//       console.error("Proxy Request Error:", err);
//       sendErrorResponse(res, 500);
//     });

//     proxyRequest.end();
//   } catch (error) {
//     console.error("Request Handler Error:", error);
//     sendErrorResponse(res, 500);
//   } finally {
//     semaphore.release();
//   }
// }

// HTTP Server
const server = http.createServer(async (req, res) => {
  await handleRequest(req, res);
});

const PORT = process.argv[2] || 8080;
server.listen(PORT, () => {
  console.log(`HTTP proxy server running on port ${PORT}`);
});

// TCP Server
const tcpServer = net.createServer((socket) => {
  console.log("TCP connection established");

  let buffer = Buffer.alloc(0);

  socket.on("data", (data) => {
    buffer = Buffer.concat([buffer, data]);

    if (buffer.length > MAX_BYTES) {
      socket.end("413 Request Entity Too Large\r\n");
      socket.destroy();
      return;
    }

    if (buffer.includes("\r\n\r\n")) {
      const request = buffer.toString();
      const [requestLine] = request.split("\r\n");
      const [method, path, httpVersion] = requestLine.split(" ");

      if (
        !method ||
        !path ||
        !httpVersion ||
        !httpVersion.startsWith("HTTP/")
      ) {
        sendErrorResponse(socket, 400, true);
        socket.destroy();
        return;
      }

      // Log the request
      console.log(`Received TCP request for: ${path}`);

      // Forward the complete request to the HTTP server
      const options = {
        hostname: "localhost",
        port: PORT,
        path: path,
        method: method,
        headers: {
          Connection: "close",
        },
      };

      const proxyReq = http.request(options, (proxyRes) => {
        socket.write(
          `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`
        );
        Object.keys(proxyRes.headers).forEach((key) => {
          socket.write(`${key}: ${proxyRes.headers[key]}\r\n`);
        });
        socket.write("\r\n");

        proxyRes.pipe(socket);
      });

      proxyReq.on("error", (err) => {
        console.error("TCP Proxy Error:", err);
        socket.end("500 Internal Server Error\r\n");
        socket.destroy();
      });

      proxyReq.end(buffer);
      buffer = Buffer.alloc(0);
    }
  });

  socket.on("error", (err) => {
    console.error("Socket Error:", err);
    socket.destroy();
  });
});

// Start TCP server
const TCP_PORT = Number(PORT) + 1;
tcpServer.listen(TCP_PORT, () => {
  console.log(`TCP server running on port ${TCP_PORT}`);
});

// Handle process termination
process.on("SIGINT", () => {
  console.log("Shutting down servers...");
  server.close();
  tcpServer.close(() => {
    process.exit(0);
  });
});
