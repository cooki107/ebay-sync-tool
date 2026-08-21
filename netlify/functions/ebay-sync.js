exports.handler = async function(event, context) {
  const https = require('https');

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const { itemId, quantity, authToken, appId, devId, certId } = JSON.parse(event.body);

  const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<ReviseItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
    <RequesterCredentials>
        <eBayAuthToken>${authToken}</eBayAuthToken>
    </RequesterCredentials>
    <Item>
        <ItemID>${itemId}</ItemID>
        <Quantity>${quantity}</Quantity>
    </Item>
    <ErrorLanguage>en_US</ErrorLanguage>
</ReviseItemRequest>`;

  const options = {
    hostname: 'api.sandbox.ebay.com',
    path: '/ws/api.dll',
    method: 'POST',
    headers: {
      'X-EBAY-API-CALL-NAME': 'ReviseItem',
      'X-EBAY-API-CERT-ID': certId,
      'X-EBAY-API-APP-ID': appId,
      'X-EBAY-API-DEV-ID': devId,
      'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
      'Content-Type': 'text/xml',
      'Content-Length': Buffer.byteLength(xmlRequest)
    }
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: 200,
          body: JSON.stringify({ success: true, response: data, httpStatus: res.statusCode })
        });
      });
    });

    req.on('error', (error) => {
      resolve({
        statusCode: 500,
        body: JSON.stringify({ success: false, error: error.message })
      });
    });

    req.write(xmlRequest);
    req.end();
  });
};
