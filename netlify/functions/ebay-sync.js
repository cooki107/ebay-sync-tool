// Netlify serverless function - runs on Netlify's servers, not blocked like my sandbox
exports.handler = async function(event, context) {
  const https = require('https');

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // Credentials now come from Netlify environment variables, NOT from the browser.
  // This prevents the Cert ID (secret) from ever being visible in page source.
  const { action, itemId, quantity, authToken, environment } = JSON.parse(event.body);

  const isProd = environment === 'production';
  const appId = isProd ? process.env.EBAY_PROD_APP_ID : process.env.EBAY_SANDBOX_APP_ID;
  const devId = isProd ? process.env.EBAY_PROD_DEV_ID : process.env.EBAY_SANDBOX_DEV_ID;
  const certId = isProd ? process.env.EBAY_PROD_CERT_ID : process.env.EBAY_SANDBOX_CERT_ID;
  const hostname = isProd ? 'api.ebay.com' : 'api.sandbox.ebay.com';

  if (!appId || !devId || !certId) {
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: `Missing ${isProd ? 'Production' : 'Sandbox'} credentials in Netlify environment variables. Set them in Site settings > Environment variables.` })
    };
  }

  let xmlRequest, callName;

  if (action === 'addItem') {
    callName = 'AddItem';
    xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<AddItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
    <RequesterCredentials>
        <eBayAuthToken>${authToken}</eBayAuthToken>
    </RequesterCredentials>
    <Item>
        <Title>Test Item - Mario Kart 8</Title>
        <Description>This is a test listing created via API for sync testing.</Description>
        <PrimaryCategory>
            <CategoryID>139973</CategoryID>
        </PrimaryCategory>
        <ItemSpecifics>
            <NameValueList>
                <Name>Platform</Name>
                <Value>Nintendo Switch</Value>
            </NameValueList>
            <NameValueList>
                <Name>Game Name</Name>
                <Value>Mario Kart 8</Value>
            </NameValueList>
        </ItemSpecifics>
        <StartPrice>10.00</StartPrice>
        <ConditionID>1000</ConditionID>
        <Country>GB</Country>
        <Currency>GBP</Currency>
        <DispatchTimeMax>3</DispatchTimeMax>
        <ListingDuration>GTC</ListingDuration>
        <ListingType>FixedPriceItem</ListingType>
        <PictureDetails>
            <PictureURL>https://i.ebayimg.com/images/g/default/s-l500.jpg</PictureURL>
        </PictureDetails>
        <PostalCode>PR25 3NF</PostalCode>
        <Quantity>${quantity || 10}</Quantity>
        <ReturnPolicy>
            <ReturnsAcceptedOption>ReturnsAccepted</ReturnsAcceptedOption>
            <ReturnsWithinOption>Days_30</ReturnsWithinOption>
            <ShippingCostPaidByOption>Buyer</ShippingCostPaidByOption>
        </ReturnPolicy>
        <ShippingDetails>
            <ShippingType>Flat</ShippingType>
            <ShippingServiceOptions>
                <ShippingServicePriority>1</ShippingServicePriority>
                <ShippingService>UK_RoyalMailFirstClassStandard</ShippingService>
                <ShippingServiceCost>2.99</ShippingServiceCost>
            </ShippingServiceOptions>
        </ShippingDetails>
        <Site>UK</Site>
    </Item>
</AddItemRequest>`;
  } else {
    callName = 'ReviseItem';
    xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
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
  }

  const options = {
    hostname: hostname,
    path: '/ws/api.dll',
    method: 'POST',
    headers: {
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-CERT-ID': certId,
      'X-EBAY-API-APP-ID': appId,
      'X-EBAY-API-DEV-ID': devId,
      'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
      'X-EBAY-API-SITEID': '3',
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
