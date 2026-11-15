'use strict';

(function () {
  const root = $.GetContextPanel();
  const compactLimit = 5;
  const boards = [
    { rows: root.FindChildTraverse('LeaderboardRows'), columns: ['wins'], pool: [] },
    { rows: root.FindChildTraverse('StandingsRows'), columns: ['wins', 'streak', 'knockouts', 'parries'], pool: [] },
  ];

  function count(value) {
    return typeof value === 'number' && isFinite(value) ? String(Math.max(0, Math.floor(value))) : '0';
  }

  function row(board, index) {
    let panel = board.pool[index];
    if (panel && panel.IsValid()) return panel;
    panel = $.CreatePanel('Panel', board.rows, '');
    panel.AddClass('ScoreRow');
    $.CreatePanel('Label', panel, 'Rank').AddClass('ScoreRank');
    $.CreatePanel('Label', panel, 'Name').AddClass('ScoreName');
    board.columns.forEach(column => $.CreatePanel('Label', panel, 'Stat_' + column).AddClass('ScoreStat'));
    board.pool[index] = panel;
    return panel;
  }

  function paint(board, scores) {
    scores.forEach((score, index) => {
      const panel = row(board, index);
      panel.visible = true;
      panel.SetHasClass('Self', score.self === true);
      panel.SetHasClass('Leader', score.leader === true);
      panel.SetHasClass('Out', score.alive !== true);
      panel.SetHasClass('OnStreak', score.streak >= 2);
      panel.FindChildTraverse('Rank').text = count(score.rank);
      panel.FindChildTraverse('Name').text = typeof score.name === 'string' ? score.name : '';
      board.columns.forEach(column => {
        const value = count(score[column]);
        panel.FindChildTraverse('Stat_' + column).text = column !== 'wins' && value === '0' ? '-' : value;
      });
    });
    for (let i = scores.length; i < board.pool.length; i++)
      if (board.pool[i].IsValid()) board.pool[i].visible = false;
  }

  function compact(scores) {
    if (scores.length <= compactLimit) return scores;
    const top = scores.slice(0, compactLimit);
    const self = scores.find(score => score.self === true);
    if (self && top.indexOf(self) < 0) top[compactLimit - 1] = self;
    return top;
  }

  Modlock.route('scores', value => {
    if (!root.IsValid()) return;
    const rows = value && typeof value === 'object' && Array.isArray(value.rows) ? value.rows : [];
    const scores = rows.filter(score => score && typeof score === 'object');
    const visible = scores.length > 0;
    const full = visible && value.full === true;
    root.SetHasClass('ShowStandings', full);
    root.SetHasClass('ShowLeaderboard', visible && !full);
    paint(boards[0], full ? [] : compact(scores));
    paint(boards[1], full ? scores : []);
  });
})();
