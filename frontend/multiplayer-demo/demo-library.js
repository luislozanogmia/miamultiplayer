(function () {
  // Each demo is a self-contained page in demos/, drawn at 1280x800.
  var DEMOS = [
    { id: 'solo', group: 'soloList', name: 'Chat', title: 'Mia builds you a bot', seconds: 40, text: 'Mia sets up a bot that consolidates your U.S. and Mexico accounts every Friday. Ask it for the report and get a PDF.' },
    { id: 'auto', group: 'soloList', name: 'Automations', title: 'Automations run on their own', seconds: 55, text: 'At 9:00 Imports Bot opens your Drive, reads each import note, checks the totals and writes the report.' },
    { id: 'learn', group: 'soloList', name: 'Artifacts', title: 'Ask for an app, then use it', seconds: 60, text: 'Mia spawns 3 agents to build a Video App. Pick any video, click Create class, and get 6 lessons.' },
    { id: 'browser', group: 'soloList', name: 'Browser', title: 'A bot browses for you', seconds: 35, text: 'Outreach Bot takes a tab group, reads 10 company sites and writes the shortlist.' },
    { id: 'multi', group: 'teamList', name: 'Channels', title: 'One bot, everyone’s own AI', seconds: 35, text: 'Ana shares Expense Report Bot with the team. Tom runs it with Grok, Ana with Claude, each on their own computer.' },
    { id: 'mpauto', group: 'teamList', name: 'Workflows', title: 'One workflow, five departments', seconds: 35, text: 'An email starts the sales workflow. Each step runs on its owner’s Mia, and the deal waits for Finance and Legal to approve.' },
    { id: 'mpart', group: 'teamList', name: 'Apps', title: 'Ask for an app, build it together', seconds: 50, text: 'Omar’s Coding Bot builds the recruiting team a hiring board. They use it live while the bot adds features and sets up hiring rules.' },
    { id: 'mpbrowser', group: 'teamList', name: 'Shared Browser', title: 'The meeting does the work', seconds: 45, text: 'In a Multiplayer call, Ana’s bot, Tom’s bot and ME each take a tab of one shared tab group, and the minimap shows everyone working live.' },
  ];
  var WIDTH = 1280, HEIGHT = 800;

  var library = document.getElementById('library');
  var player = document.getElementById('player');
  var stage = document.getElementById('playerStage');
  var win = document.getElementById('playerWin');
  var titleEl = document.getElementById('playerTitle');
  var textEl = document.getElementById('playerText');
  var nextBtn = document.getElementById('playerNext');
  var current = -1, frame = null, opener = null;

  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function row(demo, index) {
    var item = make('li');
    var button = make('button', 'lib-row');
    button.type = 'button';
    button.setAttribute('aria-label', 'Play ' + demo.name + ': ' + demo.text);
    var shot = make('span', 'lib-shot');
    var img = make('img');
    img.src = 'thumbs/' + demo.id + '.jpg';
    img.alt = '';
    img.draggable = false;
    shot.appendChild(img);
    shot.appendChild(make('span', 'lib-play'));
    var copy = make('span', 'lib-copy');
    var head = make('span', 'lib-name');
    head.appendChild(make('strong', '', demo.name));
    head.appendChild(make('span', 'lib-time', 'About ' + demo.seconds + ' s'));
    copy.appendChild(head);
    copy.appendChild(make('span', 'lib-title', demo.title));
    copy.appendChild(make('span', 'lib-text', demo.text));
    button.appendChild(shot);
    button.appendChild(copy);
    button.addEventListener('click', function () { opener = button; play(index); });
    item.appendChild(button);
    return item;
  }

  function fit() {
    if (!frame) return;
    var scale = Math.min(stage.clientWidth / WIDTH, stage.clientHeight / HEIGHT);
    win.style.width = Math.floor(WIDTH * scale) + 'px';
    win.style.height = Math.floor(HEIGHT * scale) + 'px';
    frame.style.transform = 'scale(' + scale + ')';
  }

  function controls() {
    try { return frame.contentWindow.miaDemo; } catch (_) { return null; }
  }

  function play(index) {
    var demo = DEMOS[index];
    current = index;
    library.hidden = true;
    player.hidden = false;
    titleEl.textContent = demo.name + ': ' + demo.title;
    textEl.textContent = demo.text;
    nextBtn.disabled = false;
    if (frame) frame.remove();
    frame = make('iframe');
    frame.title = demo.name + ' demo';
    frame.tabIndex = -1;
    // Watch only: a demo cannot be clicked, leave this page or open a window.
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.addEventListener('load', function () {
      var run = controls();
      if (run) run.start();
    }, { once: true });
    frame.src = 'demos/' + demo.id + '/';
    win.appendChild(frame);
    fit();
    document.getElementById('playerClose').focus();
  }

  function close() {
    if (frame) frame.remove();
    frame = null;
    current = -1;
    player.hidden = true;
    library.hidden = false;
    if (opener) opener.focus();
  }

  DEMOS.forEach(function (demo, index) {
    document.getElementById(demo.group).appendChild(row(demo, index));
  });
  document.getElementById('playerClose').addEventListener('click', close);
  document.getElementById('playerReplay').addEventListener('click', function () {
    var run = controls();
    if (run) run.replay();
  });
  nextBtn.addEventListener('click', function () {
    play((current + 1) % DEMOS.length);
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !player.hidden) close();
  });
  window.addEventListener('resize', fit);
}());
