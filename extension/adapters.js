// adapters.js -- per-site DOM adapters for the Caption assistance bridge.
//
// The composer/answer selectors used to be scattered through content.js as chatgpt.com literals, so a
// markup change broke everything at once and no other site could ever be driven. Each adapter answers the
// same few questions about a chat page; content.js never names a selector itself.
//
// Only the chatgpt.com adapter is verified against the live site. The others are best-effort starting
// points -- that is safe because content.js runs selfCheck() on bind and reports a broken adapter to the
// app instead of failing silently.
(function () {
  'use strict';

  function first(sels, root) {
    root = root || document;
    for (var i = 0; i < sels.length; i++) {
      var el = root.querySelector(sels[i]);
      if (el) return el;
    }
    return null;
  }

  var CHATGPT = {
    name: 'chatgpt',
    composer: function () {
      return first(['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]',
                    'form [contenteditable="true"]', 'form textarea', 'textarea']);
    },
    sendBtn: function () {
      return first(['button[data-testid="send-button"]', 'button[aria-label*="Send" i]',
                    'form button[type="submit"]']);
    },
    anchor: function () { return document.querySelector('[data-testid="composer-plus-btn"]'); },
    messages: function () { return Array.prototype.slice.call(document.querySelectorAll('[data-message-author-role]')); },
    roleOf: function (n) { return n.getAttribute('data-message-author-role'); },
    bodyOf: function (n) { return n.querySelector('.markdown') || n; },
    generating: function () {
      return !!first(['button[data-testid="stop-button"]', 'button[aria-label*="Stop generating" i]',
                      'button[aria-label*="Stop streaming" i]']);
    }
  };

  // Generic fallback: enough structure to drive most chat UIs, and the basis of the unverified adapters.
  var GENERIC = {
    name: 'generic',
    composer: function () {
      return first(['form [contenteditable="true"]', 'div[contenteditable="true"]', 'form textarea', 'textarea']);
    },
    sendBtn: function () {
      return first(['button[aria-label*="Send" i]', 'button[data-testid*="send" i]',
                    'button[type="submit"]', 'form button:last-of-type']);
    },
    anchor: function () {
      var c = this.composer();
      return c ? (c.closest('form') || c.parentElement) : null;
    },
    messages: function () {
      return Array.prototype.slice.call(document.querySelectorAll('[data-message-author-role],[data-message-role],[role="listitem"]'));
    },
    roleOf: function (n) {
      var r = n.getAttribute('data-message-author-role') || n.getAttribute('data-message-role') || '';
      if (r) return r;
      return /(^|\s)(assistant|model|bot)(\s|$)/i.test(n.className || '') ? 'assistant' : 'user';
    },
    bodyOf: function (n) { return n.querySelector('.markdown, .prose, [class*="markdown" i]') || n; },
    generating: function () {
      return !!first(['button[aria-label*="Stop" i]', 'button[data-testid*="stop" i]']);
    }
  };

  function derive(name, over) {
    var a = Object.create(GENERIC);
    a.name = name;
    for (var k in over) if (Object.prototype.hasOwnProperty.call(over, k)) a[k] = over[k];
    return a;
  }

  var BY_HOST = {
    'chatgpt.com': CHATGPT,
    'chat.openai.com': CHATGPT,
    // UNVERIFIED below: selfCheck() reports breakage to the app on bind.
    'aistudio.google.com': derive('aistudio', {
      composer: function () { return first(['textarea[aria-label*="prompt" i]', 'ms-autosize-textarea textarea', 'textarea']); },
      sendBtn: function () { return first(['button[aria-label*="Run" i]', 'button[type="submit"]']); }
    }),
    'claude.ai': derive('claude', {
      composer: function () { return first(['div[contenteditable="true"].ProseMirror', 'div[contenteditable="true"]']); },
      sendBtn: function () { return first(['button[aria-label*="Send" i]', 'button[type="submit"]']); }
    })
  };

  function current() { return BY_HOST[location.hostname] || GENERIC; }

  // What content.js reports to the app on bind: which primitives actually resolved on THIS page.
  function selfCheck() {
    var a = current(), out = { adapter: a.name, host: location.hostname };
    try { out.composer = !!a.composer(); } catch (e) { out.composer = false; }
    try { out.sendBtn = !!a.sendBtn(); } catch (e) { out.sendBtn = false; }
    try { out.anchor = !!a.anchor(); } catch (e) { out.anchor = false; }
    try { out.messages = a.messages().length; } catch (e) { out.messages = -1; }
    try { out.generating = a.generating(); } catch (e) { out.generating = false; }
    // A page with no conversation yet legitimately has no messages, so only the input path is required.
    out.ok = !!(out.composer && out.sendBtn);
    return out;
  }

  window.CAAdapter = { current: current, selfCheck: selfCheck, GENERIC: GENERIC, BY_HOST: BY_HOST };
})();
