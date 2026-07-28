/** 초대 저장과 로그인 비교에 함께 쓰는 이메일 정본을 만든다. */
export function canonicalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}
