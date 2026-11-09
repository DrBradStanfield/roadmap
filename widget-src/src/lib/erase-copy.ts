// The words of "Delete all my data" (US-11 AC5): the confirm before the click,
// the alert after it, and the refusal of a save the erase overtook (US-16 AC2a).
import { SHOPIFY_SURFACE } from './build-flags';

// What "Delete all my data" does, said BEFORE the click. The caveats used to
// arrive in the alert afterwards, which is too late to be a decision, and
// "permanently delete" on its own was a promise the app cannot keep: copies it
// never touches sit in the user's own cloud folder.
export const ERASE_CONFIRM =
  'Delete all your data?\n\n' +
  'Your health record and your chat history are erased, in this browser and in your connected cloud file. ' +
  'This cannot be undone. ' +
  // The erase lists the rows it can see (US-09 AC23), and keeps the rest.
  'A value another device has not saved yet, or saves while the erase runs, is kept and arrives later. ' +
  // A guest erase lists this browser's rows; a cloud connected later loses
  // them, and its profile and screenings, to the higher epoch (US-09 AC23).
  'With no cloud connected, the values in this browser are erased. If you later connect a cloud, the same values are erased there too and its profile and screening answers are reset; values this browser never held stay.\n\n' +
  `${SHOPIFY_SURFACE ? 'Seven' : 'Four'} things this cannot reach:\n` +
  '1. Documents you uploaded that are already in your cloud folder. They stay.\n' +
  '2. Candidate files from a connector import (imports/pending-*.json). They stay until your next import.\n' +
  '3. Your cloud provider keeps version history, and GitHub keeps every past commit.\n' +
  '4. Backups made by the command-line tool stay beside the file until that tool next writes it.\n' +
  // Only the Shopify build has a blog bubble, an embed and a feedback box
  // (US-11), and a server chat (US-15 AC7/AC8). Each bubble and embed row
  // copies the chat's first and last 3 questions (api.chat.ts router_context),
  // so a question lasts until 30 days after the chat's last message; the
  // widget's own rows drop those copies (redactForWidget). Just before the
  // purge blanks a health question, it keeps a scrubbed copy with no end date
  // (US-15 AC44); the erase never reaches our server, so that copy is still
  // made. No purge reaches feedback_submissions, and its email copy is
  // already in Brad's inbox.
  (SHOPIFY_SURFACE
    ? '5. On another device, the blog chat bubble and the chatbot embed keep sending your old record until the widget next loads there.\n' +
      "6. Your chat questions (the widget, the blog chat bubble and the chatbot embed) and the bubble's and embed's replies. " +
      "Our server keeps the text of each, and a chat's title, for up to 30 days after your last message in that chat. " +
      'It also keeps a copy of each health question, with no end date, to improve the chatbot. An automatic step tries to remove names and contact details first. Email us the wording to have a copy deleted. ' +
      'If you were signed in, it also keeps an account row with your name and email address.\n' +
      '7. What you sent through the feedback box. Our server keeps it with your email address, and a copy went to Brad by email.\n'
    : '') +
  '\n' +
  'Reminders are turned off. The row on our server keeps your address for 90 days, so a later ' +
  'enrolment of that address does not send a second welcome email; anyone who enrols the address ' +
  'again restarts the schedule, and each email carries the off link. ' +
  'Cancelling from a Google sign-in deletes that row.';

const ERASE_DONE_TAIL =
  '\n\nA value another device had not saved yet, or saved during the erase, is kept and arrives later.' +
  '\n\nStill in your cloud folder: the documents you uploaded, any pending import files, ' +
  'your provider\'s version history, and any command-line backups until that tool next writes the file. ' +
  'Delete those in your cloud account if you want them gone.' +
  // Items 5 to 7 of the confirm, shorter (US-11 AC5).
  (SHOPIFY_SURFACE
    ? '\n\nOn another device, the blog chat bubble and the chatbot embed send your old record until the widget loads there. ' +
      "Our server keeps your chat questions, and the bubble's and embed's replies, for up to 30 days after your last message in that chat, " +
      'and a copy of each health question, with no end date, to improve the chatbot. ' +
      'It keeps what you sent through the feedback box.'
    : '');

export const ERASE_DONE = 'Your health record and chat history are deleted.' + ERASE_DONE_TAIL;

// The chat erase is best-effort (roadmap-data.ts): an unreachable cloud must
// never trap a user's data on their device. When it fails, the tombstones are
// already in the in-memory singleton, so the next recordExchange merges them
// through sync.save. Say that, rather than claiming a deletion that did not
// happen.
export const ERASE_DONE_CHAT_PENDING =
  'Your health record is deleted. Your chat history could not be reached just now; ' +
  'it is erased on your next chat.' + ERASE_DONE_TAIL;

// The cloud chat history could not be read (US-11 AC2c), so the stored file
// still holds its conversations, and the failure may be lasting (a newer
// schema, an unreadable file). Say where it still is. If this page had it
// open, its copy is tombstoned all the same (AC2g), so a hand delete lasts.
export const ERASE_DONE_CHAT_UNREAD =
  'Your health record is deleted. Your chat history could not be read, so any chats you saved ' +
  'are still in your cloud folder, in chat-history.json.' + ERASE_DONE_TAIL;

/** A save the record refused, since it was erased under the page (US-16 AC2a). */
export const WRITE_REFUSED = 'That change was not saved: your data was just deleted, here or on another device. The page now shows your record as it is.';
