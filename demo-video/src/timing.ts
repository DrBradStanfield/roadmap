import vo from './vo.json';
import voConnect from './vo-connect.json';

/**
 * Beat starts come from vo.json (seconds), so a recorded voice-over retimes the
 * video by editing that file alone. Beat 8 is the end marker.
 * `hasVo` stays false until public/vo.mp3 exists; flip it and the <Audio> layer plays.
 */
export const hasVo = false;
export const FPS = 30;
export const WEBSITE_BEAT = 6;
export const CONNECT_WEBSITE_BEAT = 7;

export type Timing = {start: number[]; end: number; website: boolean};

const build = (beats: {start: number}[], websiteBeat: number, website: boolean): Timing => {
  const secs = beats.map((v) => v.start);
  const cut = website ? 0 : secs[websiteBeat + 1] - secs[websiteBeat];
  const start = secs.map((s, i) => Math.round((i > websiteBeat ? s - cut : s) * FPS));
  return {start, end: start[start.length - 1], website};
};

export const timing = (website: boolean): Timing => build(vo, WEBSITE_BEAT, website);
export const connectTiming = (website: boolean): Timing => build(voConnect, CONNECT_WEBSITE_BEAT, website);

export type Caption = {beat: number; at: number; lines: string[]};

/** Caption chunks, at most two lines each, timed in seconds from the beat start. */
export const CAPTIONS: Caption[] = [
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

/** Video A ("Connect your assistant"): ten beats, timed from vo-connect.json. */
export const CONNECT_CAPTIONS: Caption[] = [
  {beat: 0, at: 0, lines: ['Every new chat starts from nothing.', 'Your health record should not.']},
  {beat: 0, at: 2.0, lines: ['AI assistants give better answers from structured data.']},
  {beat: 0, at: 3.7, lines: ['Health by Dr Brad keeps your blood tests, clinic letters, height, weight and more', 'as one structured record, updated whenever you add to it.']},
  {beat: 0, at: 6.2, lines: ['One file, owned only by you, in your own Dropbox or Google Drive.', 'Every assistant, every chat, the same record.']},
  {beat: 0, at: 8.4, lines: ["And Dr Brad's protocol behind every suggestion, with the citations."]},
  {beat: 0, at: 9.9, lines: ['And the whole project is open source, so anyone can read', 'exactly what it does with your data.']},
  {beat: 1, at: 0, lines: ['First, connect. In Claude, paste the connector URL.']},
  {beat: 1, at: 2.4, lines: ['In Claude Code or Codex, one line in the terminal.']},
  {beat: 1, at: 7.0, lines: ['Then you pick Dropbox or Google Drive.']},
  {beat: 1, at: 8.6, lines: ['Your assistant reads and writes one file there.', 'Nothing is stored on our server.']},
  {beat: 2, at: 0, lines: ['Put your health data, such as blood test results and clinic letters,', 'in the Dropbox folder and ask your assistant to import them.']},
  {beat: 2, at: 5.0, lines: ['The first time, it asks your permission to run the tool.']},
  {beat: 3, at: 0, lines: ["The file passes through Dr Brad's server and the extraction model,", 'and is not kept.']},
  {beat: 3, at: 4.5, lines: ['The assistant checks every value against what your record already holds:', 'new, already recorded, or different.']},
  {beat: 3, at: 10.5, lines: ['Nothing is filed yet.']},
  {beat: 4, at: 0, lines: ['You say yes, and the values and the letter go into the one file in your Dropbox,', 'as structured data your assistant can use next time.']},
  {beat: 4, at: 4.5, lines: ['Nothing is written until you say so, and nothing is ever deleted.']},
  {beat: 5, at: 0, lines: ['Ask what your plan says.']},
  {beat: 5, at: 3.0, lines: ["It is Dr Brad's own protocol, computed from your file,", 'with the reason and the citation behind each suggestion.']},
  {beat: 5, at: 6.5, lines: ['Ask how any of it works and the assistant reads the code,', 'because all of it is public.']},
  {beat: 6, at: 0, lines: ["Don't take my word for it."]},
  {beat: 6, at: 1.6, lines: ['Paste this into ChatGPT or Claude and let it read the code.']},
  {beat: 6, at: 7.0, lines: ['The same app also runs straight from the repository on GitHub Pages,', 'with no server of mine at all.']},
  {beat: 7, at: 0, lines: ['Open the website and the same values are already there,', 'because it is one file, not a copy.']},
  {beat: 7, at: 5.5, lines: ['Change a value on the website,', 'and your assistant sees it on its next read.']},
  {beat: 7, at: 11.5, lines: ['Add one in the chat,', 'and it is on the website when you refresh.']},
  {beat: 7, at: 17.5, lines: ['Two doors, one record.']},
];
