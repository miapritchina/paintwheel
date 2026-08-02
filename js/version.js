// Build stamp.
//
// Rewritten by .github/workflows/pages.yml at deploy time with the real
// commit and timestamp, so it can never drift from what is actually served
// the way a hand-bumped version number would. In a local checkout it stays
// "dev", which is itself the useful answer.
const BUILD = { commit: 'dev', date: '', ref: 'local' };
