export interface Note {
  id: string
  authorId: string
  authorName: string
  body: string
  createdAt: number
  updatedAt: number
}

export interface NoteResponse {
  note: Note
}
