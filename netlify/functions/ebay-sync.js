// Netlify serverless function - runs on Netlify's servers, not blocked like my sandbox
const xml2js = require('xml2js');
const { getStore } = require('@netlify/blobs');

function callEbay(hostname, callName, headers, xmlRequest) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path: '/ws/api.dll',
      method: 'POST',
      headers: { ...headers, 'X-EBAY-API-CALL-NAME': callName, 'Content-Length': Buffer.byteLength(xmlRequest) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ body: data, httpStatus: res.statusCode }));
    });
    req.on('error', reject);
    req.write(xmlRequest);
    req.end();
  });
}

// Read-only - looks up a listing's currently available quantity. Never revises anything.
async function getCurrentQuantity(hostname, headers, authToken, itemId) {
  // No OutputSelector here - two earlier attempts at OutputSelector values
  // ('QuantitySold', then 'SellingStatus.QuantitySold') both silently failed to
  // return the field, so we fetch the full default response instead, which always
  // includes SellingStatus.QuantitySold.
  const getItemXml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
    <RequesterCredentials>
        <eBayAuthToken>${authToken}</eBayAuthToken>
    </RequesterCredentials>
    <ItemID>${itemId}</ItemID>
</GetItemRequest>`;
  const getItemResult = await callEbay(hostname, 'GetItem', headers, getItemXml);
  try {
    const parsed = await new xml2js.Parser({ explicitArray: false }).parseStringPromise(getItemResult.body);
    const rawQuantity = parsed?.GetItemResponse?.Item?.Quantity;
    const rawQuantitySold = parsed?.GetItemResponse?.Item?.SellingStatus?.QuantitySold;
    // Item.Quantity is the lifetime total ever listed (includes units already sold),
    // not what's currently available - subtract QuantitySold to get the real available count.
    const previousQuantity = rawQuantity !== undefined
      ? parseInt(rawQuantity, 10) - parseInt(rawQuantitySold || '0', 10)
      : null;
    // PictureURL comes back as a single string with one photo, or an array with several -
    // just take the first (the listing's primary/gallery image) for the thumbnail.
    let pictureUrl = parsed?.GetItemResponse?.Item?.PictureDetails?.PictureURL;
    if (Array.isArray(pictureUrl)) pictureUrl = pictureUrl[0];
    return { previousQuantity, pictureUrl: pictureUrl || null, quantityDebug: `GetItem Quantity=${rawQuantity}, SellingStatus.QuantitySold=${rawQuantitySold}` };
  } catch (parseErr) {
    return { previousQuantity: null, pictureUrl: null, quantityDebug: `GetItem response failed to parse: ${parseErr.message}` };
  }
}

exports.handler = async function(event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // Credentials now come from Netlify environment variables, NOT from the browser.
  // This prevents the Cert ID (secret) from ever being visible in page source.
  const { action, itemId, quantity, authToken, environment, costs } = JSON.parse(event.body);

  // Doesn't touch eBay at all - just persists game cost data (from the uploaded
  // inventory file) for the scheduled report emails to read later. No eBay
  // credentials needed, so this is handled before any of that is checked.
  if (action === 'saveCostData') {
    try {
      const store = getStore('nglh-cost-data');
      await store.setJSON('latest', costs || {});
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) {
      return { statusCode: 500, body: JSON.stringify({ success: false, error: error.message }) };
    }
  }

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

  const headers = {
    'X-EBAY-API-CERT-ID': certId,
    'X-EBAY-API-APP-ID': appId,
    'X-EBAY-API-DEV-ID': devId,
    'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
    'X-EBAY-API-SITEID': '3',
    'Content-Type': 'text/xml'
  };

  try {
    // Preview-only lookup the frontend calls right after a file upload, before any sync
    // button is pressed - just reads the current quantity, never revises the listing.
    if (action === 'getItem') {
      const { previousQuantity, pictureUrl, quantityDebug } = await getCurrentQuantity(hostname, headers, authToken, itemId);
      return { statusCode: 200, body: JSON.stringify({ success: true, previousQuantity, pictureUrl, quantityDebug }) };
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

    let previousQuantity = null;
    let quantityDebug = null;

    // For a quantity revise, look up the listing's current quantity first so the
    // UI can show a before/after, since ReviseItem's own response doesn't include it.
    if (action !== 'addItem') {
      ({ previousQuantity, quantityDebug } = await getCurrentQuantity(hostname, headers, authToken, itemId));
    }

    const { body, httpStatus } = await callEbay(hostname, callName, headers, xmlRequest);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, response: body, httpStatus, previousQuantity, quantityDebug })
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: error.message })
    };
  }
};
