export const TEST_SMS_GATEWAY_PRIMARY_DEVICE_ID =
  'android-device-1'
export const TEST_SMS_GATEWAY_SECONDARY_DEVICE_ID =
  'android-device-2'

export const TEST_SMS_GATEWAY_SIGNING_KEYS = {
  [TEST_SMS_GATEWAY_PRIMARY_DEVICE_ID]:
    'test-sms-gateway-signing-key-1',
  [TEST_SMS_GATEWAY_SECONDARY_DEVICE_ID]:
    'test-sms-gateway-signing-key-2',
} as const
