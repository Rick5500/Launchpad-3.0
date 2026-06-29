const http = require('http');

// First, get an admin token
const loginOptions = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/auth/login',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  }
};

const loginReq = http.request(loginOptions, (res) => {
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    try {
      const loginResult = JSON.parse(data);
      const token = loginResult.token;
      console.log('Got admin token:', token);
      
      // Now test the products endpoint
      const apiOptions = {
        hostname: 'localhost',
        port: 3000,
        path: '/api/products/categories',
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      };
      
      const apiReq = http.request(apiOptions, (apiRes) => {
        console.log(`Products API Status: ${apiRes.statusCode}`);
        
        let apiData = '';
        apiRes.on('data', (chunk) => {
          apiData += chunk;
        });
        
        apiRes.on('end', () => {
          console.log('Products API Response:');
          console.log(apiData);
          process.exit(0);
        });
      });
      
      apiReq.on('error', (e) => {
        console.error('API request error:', e.message);
        process.exit(1);
      });
      
      apiReq.end();
    } catch (e) {
      console.error('Parse error:', e.message);
      console.error('Response:', data);
      process.exit(1);
    }
  });
});

loginReq.on('error', (e) => {
  console.error('Login request error:', e.message);
  process.exit(1);
});

loginReq.write(JSON.stringify({ username: 'admin', password: 'adminpass' }));
loginReq.end();
