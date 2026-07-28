/** 이름의 첫 글자. 빈 문자열이어도 예외를 던지지 않는다. */
export function initialOf(name: string): string {
  return [...name][0] ?? ''
}
