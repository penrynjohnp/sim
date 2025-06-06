import type { ToolResponse } from '../types'

export interface ReadUrlParams {
  url: string
  useReaderLMv2?: boolean
  gatherLinks?: boolean
  jsonResponse?: boolean
  apiKey?: string
}

export interface ReadUrlResponse extends ToolResponse {
  output: {
    content: string
  }
}
