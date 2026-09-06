import vo from './vo.json';

/**
 * Beat starts come from vo.json (seconds), so a recorded voice-over retimes the
 * video by editing that file alone. Beat 8 is the end marker.
 * `hasVo` stays false until public/vo.mp3 exists; flip it and the <Audio> layer plays.
 */
export const hasVo = false;
export const FPS = 30;
export const WEBSITE_BEAT = 6;

export type Timing = {start: number[]; end: number; website: boolean};

export const timing = (website: boolean): Timing => {
  const secs = vo.map((v) => v.start);
  const cut = website ? 0 : secs[WEBSITE_BEAT + 1] - secs[WEBSITE_BEAT];
  const start = secs.map((s, i) => Math.round((i > WEBSITE_BEAT ? s - cut : s) * FPS));
  return {start, end: start[start.length - 1], website};
};

/** Caption chunks, at most two lines each, timed in seconds from the beat start. */
export const CAPTIONS: {beat: number; at: number; lines: string[]}[] = [
  {beat: 0, at: 0, lines: ['Every new chat starts from nothing.', 'Your health record should not.']},
  {beat: 0, at: 2.0, lines: ['AI assistants give better answers from structured data.']},
  {beat: 0, at: 3.7, lines: ['Health by Dr Brad keeps your blood tests, clinic letters, height, weight and more', 'as one structured record, updated whenever you add to it.']},
  {beat: 0, at: 6.2, lines: ['One file, owned only by you, in your own Dropbox.', 'Every assistant, every chat, the same record.']},
  {beat: 0, at: 8.3, lines: ["And Dr Brad's protocol behind every suggestion, with the citations."]},
  {beat: 1, at: 0, lines: ['First, connect. You choose Dropbox or Google Drive.']},
  {beat: 1, at: 3.5, lines: ['Your assistant reads and writes one file there.', 'Nothing is stored on our server.']},
  {beat: 2, at: 0, lines: ['Drag your ZIP file of your health data, such as blood test results', 'and clinic letters, into the chat and ask for an import.']},
  {beat: 2, at: 4.5, lines: ['The first time, the assistant asks your permission to run the tool.']},
  {beat: 3, at: 0, lines: ["The file passes through Dr Brad's server and the extraction model,", 'and is not kept.']},
  {beat: 3, at: 4.5, lines: ['The assistant checks every value against what your record already holds:', 'new, already recorded, or different.']},
  {beat: 3, at: 10.5, lines: ['Nothing is filed yet.']},
  {beat: 4, at: 0, lines: ['You say yes, and the values and the letter go into the one file in your Dropbox,', 'as structured data your assistant can use next time.']},
  {beat: 4, at: 4.5, lines: ['Nothing is written until you say so, and nothing is ever deleted.']},
  {beat: 5, at: 0, lines: ['Ask what your plan says.']},
  {beat: 5, at: 3.0, lines: ["It is Dr Brad's own protocol, computed from your file,", 'with the reason and the citation behind each suggestion.']},
  {beat: 6, at: 0, lines: ['Open the website and the same values are already there,', 'because it is one file, not a copy.']},
];
