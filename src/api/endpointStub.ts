export class EndpointStubError extends Error {
  constructor(endpoint: string) {
    super(`${endpoint} API는 아직 구현되지 않았습니다.`)
    this.name = 'EndpointStubError'
  }
}

export function createEndpointStub(endpoint: string): () => never {
  return () => {
    throw new EndpointStubError(endpoint)
  }
}
