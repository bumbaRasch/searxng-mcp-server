export interface SearchParams {
  query: string;
  categories?: string[];
  engines?: string[];
  language?: string;
  timeRange?: 'day' | 'week' | 'month' | 'year';
  pageno?: number;
  safesearch?: 0 | 1 | 2;
  maxResults?: number;
}

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  engine?: string;
  engines?: string[];
  category?: string;
  score?: number;
  publishedDate?: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  answers: string[];
  infoboxes: unknown[];
  suggestions: string[];
  unresponsiveEngines: string[];
}

export interface FetchResult {
  url: string;
  finalUrl: string;
  title?: string;
  byline?: string;
  content: string;
  truncated: boolean;
}
