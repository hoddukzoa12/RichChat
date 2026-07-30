export const TEST_SMS_GATEWAY_PRIMARY_DEVICE_ID =
  'android-device-1'
export const TEST_SMS_GATEWAY_SECONDARY_DEVICE_ID =
  'android-device-2'

export const TEST_SMS_GATEWAY_SIGNING_KEY_BY_DEVICE = {
  [TEST_SMS_GATEWAY_PRIMARY_DEVICE_ID]:
    'test-sms-gateway-signing-key-1',
  [TEST_SMS_GATEWAY_SECONDARY_DEVICE_ID]:
    'test-sms-gateway-signing-key-2',
} as const

export async function testSmsGatewaySignature(
  body: string,
  timestamp: string,
  signingKey: string,
): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(`${body}${timestamp}`),
    ),
  )
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
