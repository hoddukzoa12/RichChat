const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ENCODING_BASE = ENCODING.length
const TIME_LENGTH = 10
const RANDOM_LENGTH = 16
const MAX_TIME = 2 ** 48 - 1

export type Clock = () => number

function validateTime(time: number): void {
  if (!Number.isInteger(time) || time < 0 || time > MAX_TIME) {
    throw new RangeError('ULID 시각은 유효한 epoch 밀리초여야 합니다.')
  }
}

function encodeTime(time: number): string {
  const encoded = new Array<string>(TIME_LENGTH)
  let remaining = time

  for (let index = TIME_LENGTH - 1; index >= 0; index -= 1) {
    encoded[index] = ENCODING[remaining % ENCODING_BASE]
    remaining = Math.floor(remaining / ENCODING_BASE)
  }

  return encoded.join('')
}

function randomPart(): Uint8Array {
  const values = crypto.getRandomValues(new Uint8Array(RANDOM_LENGTH))

  for (let index = 0; index < values.length; index += 1) {
    values[index] &= ENCODING_BASE - 1
  }

  return values
}

function increment(values: Uint8Array): boolean {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] < ENCODING_BASE - 1) {
      values[index] += 1
      return true
    }

    values[index] = 0
  }

  return false
}

function encodeRandom(values: Uint8Array): string {
  let encoded = ''

  for (const value of values) {
    encoded += ENCODING[value]
  }

  return encoded
}

/**
 * 생성 순서와 문자열 정렬 순서가 일치하는 ULID 생성기를 만든다.
 * 벽시계가 같은 값에 머물거나 뒤로 가도 마지막 난수부를 증가시킨다.
 */
export function createUlidFactory(clock: Clock = Date.now): () => string {
  let lastTime = -1
  let lastRandom: Uint8Array = new Uint8Array(RANDOM_LENGTH)

  return () => {
    const currentTime = clock()
    validateTime(currentTime)

    if (currentTime > lastTime) {
      lastTime = currentTime
      lastRandom = randomPart()
    } else if (!increment(lastRandom)) {
      if (lastTime === MAX_TIME) {
        throw new RangeError('ULID 시각 범위를 초과했습니다.')
      }

      // 같은 밀리초의 난수 공간을 모두 쓴 경우 논리 시각을 한 칸 전진시킨다.
      lastTime += 1
    }

    return encodeTime(lastTime) + encodeRandom(lastRandom)
  }
}

export const createId = createUlidFactory()
