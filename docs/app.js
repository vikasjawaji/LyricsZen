/**
 * LyricsZen GitHub Pages Interactive Demo Controller
 */
(function() {
  'use strict';

  // Demo Lyrics Dataset: Blinding Lights - The Weeknd
  const DEMO_LYRICS = [
    { time: 0, text: '♪ (Synth Intro) ♪' },
    { time: 6, text: "Yeah..." },
    { time: 10, text: "I've been tryna call" },
    { time: 14, text: "I've been on my own for long enough" },
    { time: 19, text: "Maybe you can show me how to love, maybe" },
    { time: 26, text: "I'm going through withdrawals" },
    { time: 30, text: "You don't even have to do too much" },
    { time: 34, text: "You can turn me on with just a touch, baby" },
    { time: 40, text: "I look around and Sin City's cold and empty" },
    { time: 45, text: "No one's around to judge me" },
    { time: 49, text: "I can't see clearly when you're gone" },
    { time: 54, text: "I said, ooh, I'm blinded by the lights" },
    { time: 60, text: "No, I can't sleep until I feel your touch" },
  ];

  const DURATION = 65; // seconds
  let isPlaying = false;
  let currentTime = 0;
  let playInterval = null;
  let activeIndex = 0;
  let partyMode = true;
  let currentVisualizer = 'bars';

  // DOM Elements
  const track = document.getElementById('demo-lyrics-track');
  const viewport = document.getElementById('demo-viewport');
  const playBtn = document.getElementById('demo-play-btn');
  const iconPlay = playBtn.querySelector('.demo-icon-play');
  const iconPause = playBtn.querySelector('.demo-icon-pause');
  const prevBtn = document.getElementById('demo-prev-btn');
  const nextBtn = document.getElementById('demo-next-btn');
  const slider = document.getElementById('demo-progress-slider');
  const timeCur = document.getElementById('demo-time-cur');
  const timeTotal = document.getElementById('demo-time-total');
  const partyToggle = document.getElementById('demo-toggle-party');
  const partyStatus = document.getElementById('demo-party-status');
  const styleBtn = document.getElementById('demo-style-btn');
  const styleName = document.getElementById('demo-style-name');
  const styleMenu = document.getElementById('demo-style-menu');
  const visualizerBox = document.getElementById('demo-visualizer');
  const fontSelect = document.getElementById('demo-font-select');
  const sizeRange = document.getElementById('demo-size-range');
  const sizeVal = document.getElementById('demo-size-val');
  const colorDots = document.querySelectorAll('.demo-dot');

  // Render Visualizer Edge elements
  function buildVisualizers() {
    const edges = visualizerBox.querySelectorAll('.demo-edge');
    edges.forEach(edge => {
      edge.innerHTML = '';
      const count = edge.classList.contains('demo-edge-top') || edge.classList.contains('demo-edge-bottom') ? 24 : 14;
      for (let i = 0; i < count; i++) {
        const span = document.createElement('i');
        span.style.setProperty('--i', i);
        edge.appendChild(span);
      }
    });
    visualizerBox.className = `demo-edge-visualizer vis-${currentVisualizer}`;
  }

  // Format seconds to mm:ss
  function formatTime(s) {
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }

  // Populate Lyric Lines
  function renderLines() {
    track.innerHTML = '';
    DEMO_LYRICS.forEach((item, index) => {
      const p = document.createElement('p');
      p.className = 'demo-line';
      p.textContent = item.text;
      p.dataset.time = item.time;
      p.dataset.index = index;
      p.addEventListener('click', () => {
        seekTo(item.time);
      });
      track.appendChild(p);
    });
    updateActiveLine(0, false);
  }

  // Find active line index based on time
  function getActiveIndex(t) {
    for (let i = DEMO_LYRICS.length - 1; i >= 0; i--) {
      if (t >= DEMO_LYRICS[i].time) return i;
    }
    return 0;
  }

  // Center active line in viewport
  function updateActiveLine(index, smooth = true) {
    activeIndex = index;
    const lines = track.querySelectorAll('.demo-line');
    lines.forEach((line, i) => {
      line.classList.toggle('is-active', i === index);
      line.classList.toggle('is-near', Math.abs(i - index) === 1);
    });

    const activeEl = lines[index];
    if (activeEl && viewport) {
      const trackRect = track.getBoundingClientRect();
      const elRect = activeEl.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();

      // Current distance of activeEl from track top
      const elOffsetFromTrack = (elRect.top - trackRect.top) + (elRect.height / 2);
      const viewportCenter = viewportRect.height / 2;

      // Translate track vertically so active line is right in the center
      const translateY = viewportCenter - elOffsetFromTrack;
      track.style.transform = `translateY(${translateY}px)`;
    }
  }

  function tick() {
    currentTime += 0.2;
    if (currentTime >= DURATION) {
      pause();
      currentTime = 0;
    }
    syncTimeUI();
    const idx = getActiveIndex(currentTime);
    if (idx !== activeIndex) {
      updateActiveLine(idx, true);
    }
  }

  function syncTimeUI() {
    timeCur.textContent = formatTime(currentTime);
    slider.value = (currentTime / DURATION) * 100;
  }

  function play() {
    if (isPlaying) return;
    isPlaying = true;
    iconPlay.style.display = 'none';
    iconPause.style.display = 'block';
    playInterval = setInterval(tick, 200);
  }

  function pause() {
    if (!isPlaying) return;
    isPlaying = false;
    iconPlay.style.display = 'block';
    iconPause.style.display = 'none';
    clearInterval(playInterval);
    playInterval = null;
  }

  function togglePlay() {
    if (isPlaying) pause();
    else play();
  }

  function seekTo(s) {
    currentTime = Math.max(0, Math.min(DURATION, s));
    syncTimeUI();
    const idx = getActiveIndex(currentTime);
    updateActiveLine(idx, true);
  }

  // Event Listeners
  playBtn.addEventListener('click', togglePlay);

  prevBtn.addEventListener('click', () => {
    const newIdx = Math.max(0, activeIndex - 1);
    seekTo(DEMO_LYRICS[newIdx].time);
  });

  nextBtn.addEventListener('click', () => {
    const newIdx = Math.min(DEMO_LYRICS.length - 1, activeIndex + 1);
    seekTo(DEMO_LYRICS[newIdx].time);
  });

  slider.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    seekTo((val / 100) * DURATION);
  });

  // Party Mode Toggle
  partyToggle.addEventListener('click', () => {
    partyMode = !partyMode;
    partyStatus.textContent = partyMode ? 'ON' : 'OFF';
    visualizerBox.style.opacity = partyMode ? '0.9' : '0';
  });

  // Visualizer style dropdown
  styleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    styleMenu.classList.toggle('is-open');
  });

  document.addEventListener('click', () => {
    styleMenu.classList.remove('is-open');
  });

  styleMenu.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      styleMenu.querySelectorAll('button').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      currentVisualizer = btn.dataset.style;
      styleName.textContent = btn.textContent;
      visualizerBox.className = `demo-edge-visualizer vis-${currentVisualizer}`;
    });
  });

  // Font customization
  fontSelect.addEventListener('change', (e) => {
    const val = e.target.value;
    const fonts = {
      serif: 'Georgia, serif',
      sans: "'Plus Jakarta Sans', sans-serif",
      rounded: "system-ui, -apple-system, sans-serif",
      display: "'Outfit', sans-serif"
    };
    track.style.fontFamily = fonts[val] || 'inherit';
    updateActiveLine(activeIndex, false);
  });

  // Size customization
  sizeRange.addEventListener('input', (e) => {
    const size = `${e.target.value}px`;
    sizeVal.textContent = size;
    track.querySelectorAll('.demo-line').forEach(line => {
      line.style.fontSize = size;
    });
    updateActiveLine(activeIndex, false);
  });

  // Color customization
  colorDots.forEach(dot => {
    dot.addEventListener('click', () => {
      colorDots.forEach(d => d.classList.remove('is-active'));
      dot.classList.add('is-active');
      const color = dot.dataset.color;
      track.style.setProperty('--line-active-color', color);
      track.querySelectorAll('.demo-line.is-active').forEach(el => {
        el.style.color = color;
      });
    });
  });

  // Window resize re-center
  window.addEventListener('resize', () => {
    updateActiveLine(activeIndex, false);
  });

  // Initialize
  buildVisualizers();
  renderLines();
  timeTotal.textContent = formatTime(DURATION);
  syncTimeUI();
})();
