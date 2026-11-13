/**
 * The page's link rewrite for tools/md-artifact.mjs, kept apart so a node test can call it
 * (md-artifact.mjs runs as a script on import). The page inlines this function's source, so it
 * stays ES5 and uses nothing from outside its own body.
 *
 * linkHook(links) is a marked extension: its walkTokens swaps the href of each Markdown `link`
 * token found in `links` (the build's {relative target path -> URL} map), keeping the #fragment.
 * Every other token (code, code spans, images, raw HTML) is never touched.
 */
export function linkHook(links) {
  var own = function (p) { return Object.prototype.hasOwnProperty.call(links, p); };
  var mapHref = function (href) {
    var i = (href + '#').indexOf('#'), p = href.slice(0, i), d = p;
    try { d = decodeURI(p); } catch (e) {}
    return own(p) ? links[p] + href.slice(i) : own(d) ? links[d] + href.slice(i) : null;
  };
  return { walkTokens: function (t) {
    if (t.type === 'link') t.href = mapHref(t.href) || t.href;
  } };
}
