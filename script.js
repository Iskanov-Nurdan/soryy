/* ==========================================================================
   Прости меня — логика

   Фотки лежат в папке image. Чтобы поменять или добавить — просто правь
   массив PHOTOS ниже: индекс = уровень грусти (0 — спокойный, 5 — рыдает).
   Если картинка не загрузилась, берётся ближайшая предыдущая.
   ========================================================================== */

(function () {
  'use strict';

  /* --- настройки: какая фотка на каком уровне ---------------------------- */

  var CALM = 'image/62bbe2d7-25a9-46e6-a5e1-0ecf109baac8.jpg'; // просто грустный
  var TEAR = 'image/01c72e76-ffd4-4b6b-b0ed-8606385492e5.jpg'; // одна слезинка
  var CRY  = 'image/a1d0e12f-78b5-4f2a-9609-59b3db81dd75.jpg'; // рыдает в три ручья

  var PHOTOS = [
    CALM,  // 0 — старт, погода ясная
    CALM,  // 1 — небо хмурится
    TEAR,  // 2 — пошёл дождь
    TEAR,  // 3 — ливень
    CRY,   // 4 — ГРОЗА
    CRY    // 5 — конец света
  ];

  /* погода по уровням: 0 — ясно, 1 — дождь, 2 — гроза */
  var WEATHER = [0, 0, 1, 1, 2, 2];

  var PHOTO_YES = CALM; // после «Прощаю»

  /* слова под фото: [крупно, помельче] */
  var WORDS = [
    ['ПРОСТИ',             'я правда не хотел'],
    ['ПРОСТИ, ПОЖАЛУЙСТА', 'мне очень стыдно'],
    ['НУ ПРОСТИ',          'я не могу без тебя'],
    ['ПРОСТИИИ',           'я больше так не буду'],
    ['ПРОСТИ МЕНЯ',        'я очень очень сожалею'],
    ['ПРОСТИ',             'я сильно сильно сильно сильно люблю ']
  ];

  var NO_LABELS = ['Нет', 'Всё ещё нет', 'Нет...', 'Не-а', 'Нет?', 'Ну нет'];

  var FORGIVEN_WORD = 'СПАСИБО';
  var FORGIVEN_SUB  = 'прости жанм я больше так не буду делать';

  var MAX_LEVEL = PHOTOS.length - 1;

  /* --- элементы ----------------------------------------------------------- */

  var body      = document.body;
  var frame     = document.querySelector('.photo-frame');
  var photo     = document.querySelector('.photo-img');
  var wordEl    = document.querySelector('.word');
  var subwordEl = document.querySelector('.subword');
  var counterEl = document.querySelector('.counter-value');
  var tearsBox  = document.querySelector('.tears');
  var btnYes    = document.querySelector('.btn--yes');
  var btnNo     = document.querySelector('.btn--no');

  var level      = 0;
  var refusals   = 0;
  var forgiven   = false;
  var tearTimer  = null;
  var boltTimer  = null;

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* --- предзагрузка ------------------------------------------------------- */

  var alive = {}; // url -> true, если картинка реально загрузилась

  function preloadAll(done) {
    var urls = PHOTOS.concat([PHOTO_YES]).filter(function (url, i, all) {
      return all.indexOf(url) === i;
    });
    var left = urls.length;

    if (left === 0) { done(); return; }

    urls.forEach(function (url) {
      var probe = new Image();
      probe.onload = function () { alive[url] = true; finish(); };
      probe.onerror = finish;
      probe.src = url;

      function finish() {
        left -= 1;
        if (left === 0) done();
      }
    });
  }

  /* картинка уровня, а если её нет — ближайшая рабочая */
  function photoForLevel(n) {
    var i;
    for (i = n; i >= 0; i--) {
      if (alive[PHOTOS[i]]) return PHOTOS[i];
    }
    for (i = n + 1; i <= MAX_LEVEL; i++) {
      if (alive[PHOTOS[i]]) return PHOTOS[i];
    }
    return null;
  }

  function showPhoto(url) {
    if (!url) {
      frame.classList.add('is-empty');
      return;
    }
    frame.classList.remove('is-empty');
    if (photo.getAttribute('src') === url) return;

    photo.classList.remove('is-ready');
    photo.src = url;
    if (photo.complete) {
      photo.classList.add('is-ready');
    } else {
      photo.onload = function () { photo.classList.add('is-ready'); };
    }
  }

  /* --- слёзы поверх фото --------------------------------------------------- */

  function spawnTear() {
    var tear = document.createElement('span');
    var fromLeftEye = Math.random() < 0.5;
    var jitter = (Math.random() * 8) - 4;
    var size = 8 + level * 2 + Math.random() * 5;
    var duration = 900 - level * 60 + Math.random() * 300;

    tear.className = 'tear';
    tear.style.setProperty('--x', (fromLeftEye ? 33 : 60) + jitter + '%');
    tear.style.setProperty('--y', 52 + Math.random() * 6 + '%');
    tear.style.setProperty('--size', size.toFixed(1) + 'px');
    tear.style.setProperty('--dur', Math.round(duration) + 'ms');

    tearsBox.appendChild(tear);
    tear.addEventListener('animationend', function () { tear.remove(); });
  }

  function restartTears() {
    if (tearTimer !== null) {
      window.clearInterval(tearTimer);
      tearTimer = null;
    }
    if (level === 0 || forgiven || reducedMotion) return;

    var interval = Math.max(70, 620 - level * 105);
    tearTimer = window.setInterval(function () {
      var drops = level >= 4 ? 2 : 1;
      for (var i = 0; i < drops; i++) spawnTear();
    }, interval);
  }

  /* --- гроза ----------------------------------------------------------------- */

  function flash() {
    body.classList.remove('is-flash');
    void body.offsetWidth;          // перезапуск анимации вспышки
    body.classList.add('is-flash');
  }

  function restartLightning() {
    if (boltTimer !== null) {
      window.clearTimeout(boltTimer);
      boltTimer = null;
    }
    body.classList.remove('is-flash');

    if (forgiven || reducedMotion || WEATHER[level] !== 2) return;

    // молнии бьют неравномерно — так честнее
    (function strike() {
      var pause = level >= 5 ? 900 + Math.random() * 1400
                             : 1800 + Math.random() * 2600;
      boltTimer = window.setTimeout(function () {
        flash();
        strike();
      }, pause);
    }());

    flash(); // первая — сразу, чтобы гроза не подкрадывалась
  }

  /* --- отрисовка состояния -------------------------------------------------- */

  function render() {
    var words = WORDS[Math.min(level, WORDS.length - 1)];

    body.setAttribute('data-level', String(level));
    body.setAttribute('data-weather', String(WEATHER[level]));
    counterEl.textContent = String(refusals);
    wordEl.textContent = words[0];
    subwordEl.textContent = words[1];
    btnNo.textContent = NO_LABELS[Math.min(level, NO_LABELS.length - 1)];
    photo.alt = 'Котик просит прощения';

    showPhoto(photoForLevel(level));

    // перезапуск анимации текста
    wordEl.style.animation = 'none';
    subwordEl.style.animation = 'none';
    void wordEl.offsetWidth;
    wordEl.style.animation = '';
    subwordEl.style.animation = '';

    restartTears();
    restartLightning();
  }

  /* --- события --------------------------------------------------------------- */

  btnNo.addEventListener('click', function () {
    if (forgiven) return;
    refusals += 1;
    if (level < MAX_LEVEL) level += 1;
    render();

    if (level === MAX_LEVEL && !reducedMotion) {
      for (var i = 0; i < 14; i++) window.setTimeout(spawnTear, i * 45);
    }
  });

  btnYes.addEventListener('click', function () {
    if (forgiven) return;
    forgiven = true;
    level = 0;

    body.setAttribute('data-forgiven', 'true');
    body.setAttribute('data-level', '0');
    body.setAttribute('data-weather', '0');

    wordEl.textContent = FORGIVEN_WORD;
    subwordEl.textContent = FORGIVEN_SUB;
    photo.alt = 'Счастливый котик';

    restartTears();
    restartLightning();
    tearsBox.textContent = '';
    showPhoto(alive[PHOTO_YES] ? PHOTO_YES : photoForLevel(0));
  });

  /* --- старт ----------------------------------------------------------------- */

  frame.classList.add('is-empty');
  preloadAll(render);
}());
