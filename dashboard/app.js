/* Token Radar — reads window.RADAR, renders the ranked board and the live list. */
(function () {
  'use strict';

  var RADAR = window.RADAR || { rows: [], live: [], model: {}, watchlist: [] };
  var ROWS = Array.isArray(RADAR.rows) ? RADAR.rows.slice() : [];
  var LIVE = Array.isArray(RADAR.live) ? RADAR.live.slice() : [];

  var state = { q: '', category: '', sort: 'implied', view: 'board', selected: null };

  var el = {
    q: document.getElementById('q'),
    category: document.getElementById('category'),
    sort: document.getElementById('sort'),
    tabBoard: document.getElementById('tab-board'),
    tabLive: document.getElementById('tab-live'),
    viewBoard: document.getElementById('view-board'),
    viewLive: document.getElementById('view-live'),
    board: document.getElementById('board'),
    live: document.getElementById('live'),
    boardEmpty: document.getElementById('board-empty'),
    liveEmpty: document.getElementById('live-empty'),
    detail: document.getElementById('detail'),
    asof: document.getElementById('meta-asof'),
    model: document.getElementById('meta-model'),
    boardCount: document.getElementById('meta-board'),
    liveCount: document.getElementById('meta-live'),
    source: document.getElementById('foot-source'),
  };

  /* ------------------------------------------------------------ format */

  function money(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    var abs = Math.abs(n);
    if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }

  function precise(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return '$' + Math.round(n).toLocaleString('en-US');
  }

  function pct(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    var sign = n > 0 ? '+' : '';
    return sign + n.toFixed(1) + '%';
  }

  function trendClass(n) {
    if (n === null || n === undefined || isNaN(n)) return 'flat';
    if (n > 0.05) return 'up';
    if (n < -0.05) return 'down';
    return 'flat';
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function shortChains(chains) {
    if (!Array.isArray(chains) || chains.length === 0) return '—';
    if (chains.length <= 2) return chains.join(', ');
    return chains[0] + ' +' + (chains.length - 1);
  }

  /* ------------------------------------------------------------ filtering */

  function matches(row) {
    if (state.category && row.category !== state.category) return false;
    if (!state.q) return true;
    var q = state.q.toLowerCase();
    if (row.name.toLowerCase().indexOf(q) !== -1) return true;
    if ((row.slug || '').toLowerCase().indexOf(q) !== -1) return true;
    if ((row.symbol || '').toLowerCase().indexOf(q) !== -1) return true;
    if ((row.category || '').toLowerCase().indexOf(q) !== -1) return true;
    return (row.chains || []).some(function (c) { return c.toLowerCase().indexOf(q) !== -1; });
  }

  function sorted(list) {
    var copy = list.slice();
    if (state.sort === 'tvl') {
      copy.sort(function (a, b) {
        return (b.tvl_usd || 0) - (a.tvl_usd || 0) || (a.rank || 0) - (b.rank || 0);
      });
    } else if (state.sort === 'growth') {
      // Missing change sorts last, never as zero: unknown is not "flat".
      var g = function (r) { return r.change_7d === null || r.change_7d === undefined ? -Infinity : r.change_7d; };
      copy.sort(function (a, b) { return g(b) - g(a) || (a.rank || 0) - (b.rank || 0); });
    } else if (state.sort === 'young') {
      copy.sort(function (a, b) {
        var ay = a.age_days === null || a.age_days === undefined ? Infinity : a.age_days;
        var by = b.age_days === null || b.age_days === undefined ? Infinity : b.age_days;
        return ay - by || (a.rank || 0) - (b.rank || 0);
      });
    } else if (state.sort === 'name') {
      copy.sort(function (a, b) { return a.name.localeCompare(b.name); });
    } else {
      // Implied value: fall back to the model's own order (rank) so rows with an
      // equal implied value never shuffle between renders.
      copy.sort(function (a, b) {
        return (b.implied_value_usd || 0) - (a.implied_value_usd || 0) || (a.rank || 0) - (b.rank || 0);
      });
    }
    return copy;
  }

  /* ------------------------------------------------------------ render */

  function buildCategories() {
    var seen = {};
    ROWS.forEach(function (r) { if (r.category) seen[r.category] = (seen[r.category] || 0) + 1; });
    LIVE.forEach(function (r) { if (r.category) seen[r.category] = (seen[r.category] || 0) + 1; });
    var names = Object.keys(seen).sort(function (a, b) { return seen[b] - seen[a] || a.localeCompare(b); });
    names.forEach(function (name) {
      var opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name + ' (' + seen[name] + ')';
      el.category.appendChild(opt);
    });
  }

  function rowHtml(row, isLive) {
    var rank = isLive ? '·' : String(row.rank);
    var sub = isLive ? (row.symbol ? '$' + esc(row.symbol) : 'token trading') : esc(row.slug);
    var on = state.selected === row.slug ? ' is-on' : '';
    var head =
      '<li class="' + (isLive ? 'live-row' : 'board-row') + on + '" data-slug="' + esc(row.slug) + '" tabindex="0" role="button">' +
      (isLive ? '' : '<span class="c-rank">' + rank + '</span>') +
      '<span class="c-name"><span class="p-name">' + esc(row.name) + '</span><span class="p-sub">' + sub + '</span></span>' +
      '<span class="c-cat">' + esc(row.category) + '</span>' +
      '<span class="c-chains">' + esc(shortChains(row.chains)) + '</span>' +
      '<span class="c-num">' + money(row.tvl_usd) + '</span>';
    if (isLive) {
      return head +
        '<span class="c-num">' + money(row.mcap_usd) + '</span>' +
        '<span class="c-num ' + trendClass(row.change_7d) + '">' + pct(row.change_7d) + '</span>' +
        '</li>';
    }
    return head +
      '<span class="c-num ' + trendClass(row.change_7d) + '">' + pct(row.change_7d) + '</span>' +
      '<span class="c-num strong">' + money(row.implied_value_usd) + '</span>' +
      '</li>';
  }

  function renderBoard() {
    var list = sorted(ROWS.filter(matches));
    el.board.innerHTML = list.map(function (r) { return rowHtml(r, false); }).join('');
    el.boardEmpty.hidden = list.length !== 0;
    // A filter can hide the selected row; drop the detail rather than show a
    // protocol that is no longer on screen.
    if (state.selected && !list.some(function (r) { return r.slug === state.selected; })) {
      clearSelection();
    }
  }

  function renderLive() {
    var list = sorted(LIVE.filter(matches));
    el.live.innerHTML = list.map(function (r) { return rowHtml(r, true); }).join('');
    el.liveEmpty.hidden = list.length !== 0;
  }

  /* ------------------------------------------------------------ detail */

  function derivation(row) {
    var m = row.model || {};
    var base = m.base_multiple;
    var gm = m.growth_multiplier;
    var mm = m.maturity_multiplier;
    return '' +
      '<div class="derivation">' +
      'TVL <b>' + money(row.tvl_usd) + '</b><br>' +
      '× base multiple <b>' + base + '</b><br>' +
      '× growth <b>' + gm + '</b> <span>(7d ' + pct(m.growth_pct) + ', capped)</span><br>' +
      '× maturity <b>' + mm + '</b> <span>(age ' + (m.age_days === null ? 'unknown' : m.age_days + 'd') + ')</span><br>' +
      '= <span class="total">' + precise(row.implied_value_usd) + '</span>' +
      '</div>';
  }

  function renderDetail(slug, isLive) {
    var row = (isLive ? LIVE : ROWS).filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    var parts = [];
    parts.push('<button class="close" id="detail-close">Close</button>');
    parts.push('<h2>' + esc(row.name) + '</h2>');
    parts.push('<div class="slug">' + esc(row.slug) + (row.symbol ? ' · $' + esc(row.symbol) : '') + '</div>');

    if (isLive) {
      parts.push('<h3>Market</h3><dl class="kv">' +
        '<dt>Category</dt><dd>' + esc(row.category) + '</dd>' +
        '<dt>TVL</dt><dd>' + money(row.tvl_usd) + '</dd>' +
        '<dt>Market cap</dt><dd>' + money(row.mcap_usd) + '</dd>' +
        '<dt>7-day change</dt><dd class="' + trendClass(row.change_7d) + '">' + pct(row.change_7d) + '</dd>' +
        '<dt>Listed</dt><dd>' + esc(row.listed_at || 'unknown') + '</dd>' +
        '</dl>');
      parts.push('<h3>Chains</h3><div class="chips">' + (row.chains || []).map(function (c) { return '<span class="chip">' + esc(c) + '</span>'; }).join('') + '</div>');
      parts.push('<h3>Why it is not ranked</h3><p class="view-note">' + esc(row.name) + ' already has a token trading, so there is no pre-token position. It is listed here for scale against the board.</p>');
    } else {
      parts.push('<h3>Numbers</h3><dl class="kv">' +
        '<dt>Rank</dt><dd>' + row.rank + '</dd>' +
        '<dt>Category</dt><dd>' + esc(row.category) + '</dd>' +
        '<dt>TVL</dt><dd>' + money(row.tvl_usd) + '</dd>' +
        '<dt>7-day change</dt><dd class="' + trendClass(row.change_7d) + '">' + pct(row.change_7d) + '</dd>' +
        '<dt>Implied value</dt><dd class="up">' + precise(row.implied_value_usd) + '</dd>' +
        '<dt>Listed</dt><dd>' + esc(row.listed_at || 'unknown') + '</dd>' +
        '<dt>Age</dt><dd>' + (row.age_days === null ? 'unknown' : row.age_days + ' days') + '</dd>' +
        '</dl>');
      parts.push('<h3>How the value was derived</h3>' + derivation(row));
      parts.push('<h3>Chains</h3><div class="chips">' + (row.chains || []).map(function (c) { return '<span class="chip">' + esc(c) + '</span>'; }).join('') + '</div>');
      parts.push('<h3>Farm steps</h3><ol class="steps">' + (row.farm_steps || []).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>');
    }

    el.detail.innerHTML = parts.join('');
    var close = document.getElementById('detail-close');
    if (close) close.addEventListener('click', clearSelection);
  }

  function clearSelection() {
    state.selected = null;
    el.detail.innerHTML = '<div class="detail-idle"><h2>Pick a row</h2><p>Choose a protocol to see its numbers, how the model reached its implied value, and the steps to take a position.</p></div>';
    var on = el.board.querySelector('.is-on');
    if (on) on.classList.remove('is-on');
  }

  /* ------------------------------------------------------------ events */

  function onListClick(e) {
    var li = e.target.closest('li[data-slug]');
    if (!li) return;
    var isLive = li.classList.contains('live-row');
    var list = li.parentElement.querySelectorAll('.is-on');
    Array.prototype.forEach.call(list, function (n) { n.classList.remove('is-on'); });
    li.classList.add('is-on');
    renderDetail(li.getAttribute('data-slug'), isLive);
  }

  function switchView(view) {
    state.view = view;
    el.viewBoard.hidden = view !== 'board';
    el.viewLive.hidden = view !== 'live';
    el.tabBoard.classList.toggle('is-on', view === 'board');
    el.tabLive.classList.toggle('is-on', view === 'live');
    el.tabBoard.setAttribute('aria-selected', view === 'board' ? 'true' : 'false');
    el.tabLive.setAttribute('aria-selected', view === 'live' ? 'true' : 'false');
    clearSelection();
  }

  function wire() {
    el.q.addEventListener('input', function () { state.q = el.q.value.trim(); renderBoard(); renderLive(); });
    el.category.addEventListener('change', function () { state.category = el.category.value; renderBoard(); renderLive(); });
    el.sort.addEventListener('change', function () { state.sort = el.sort.value; renderBoard(); renderLive(); });
    el.tabBoard.addEventListener('click', function () { switchView('board'); });
    el.tabLive.addEventListener('click', function () { switchView('live'); });
    el.board.addEventListener('click', onListClick);
    el.live.addEventListener('click', onListClick);
    el.board.addEventListener('keydown', function (e) { if (e.key === 'Enter') onListClick(e); });
    el.live.addEventListener('keydown', function (e) { if (e.key === 'Enter') onListClick(e); });
  }

  function header() {
    el.asof.textContent = RADAR.as_of || 'undated';
    el.model.textContent = RADAR.model_version || '—';
    el.boardCount.textContent = String(ROWS.length);
    el.liveCount.textContent = String(LIVE.length);
    el.source.textContent = 'Source: ' + (RADAR.source || 'unknown') + (RADAR.watchlist ? ' · watchlist ' + RADAR.watchlist.length : '');
  }

  header();
  buildCategories();
  wire();
  renderBoard();
  renderLive();
})();
