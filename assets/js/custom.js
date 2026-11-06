/* ============================================================
   Aman Yadav — custom interactions
   ============================================================ */
(function () {
    'use strict';

    /* ---------- Let real page links escape the one-page-nav scroll hijack ---------- */
    if (window.jQuery) {
        jQuery(function () {
            jQuery('.onepagenav a.external').off('click.onePageNav');
        });
    }

    /* ---------- Typing role rotator ---------- */
    var roles = [
        'Unity 3D Developer.',
        'VR Developer.',
        'AR Experience Developer.',
        'Mobile Game Developer.'
    ];
    var typedEl = document.getElementById('typed-role');
    if (typedEl) {
        var roleIdx = 0, charIdx = roles[0].length, deleting = false;
        var tick = function () {
            var word = roles[roleIdx];
            typedEl.textContent = word.slice(0, charIdx);
            var delay;
            if (!deleting && charIdx < word.length) {
                charIdx++; delay = 65;
            } else if (!deleting) {
                deleting = true; delay = 1800;
            } else if (charIdx > 0) {
                charIdx--; delay = 35;
            } else {
                deleting = false;
                roleIdx = (roleIdx + 1) % roles.length;
                delay = 350;
            }
            setTimeout(tick, delay);
        };
        setTimeout(tick, 1800);
    }

    /* ---------- Hero particle field ---------- */
    var prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var isSmallScreen = window.matchMedia && window.matchMedia('(max-width: 767px)').matches;
    if (window.particlesJS && document.getElementById('hero-particles') && !prefersReducedMotion) {
        particlesJS('hero-particles', {
            particles: {
                number: { value: isSmallScreen ? 24 : 55, density: { enable: true, value_area: 900 } },
                color: { value: ['#f9004d', '#ffffff', '#3d7bff'] },
                shape: { type: 'circle' },
                opacity: { value: 0.35, random: true },
                size: { value: 2.6, random: true },
                line_linked: {
                    enable: true,
                    distance: 140,
                    color: '#8a93a5',
                    opacity: 0.18,
                    width: 1
                },
                move: { enable: true, speed: 1.1, out_mode: 'out' }
            },
            interactivity: {
                detect_on: 'canvas',
                events: {
                    onhover: { enable: true, mode: 'grab' },
                    onclick: { enable: true, mode: 'push' },
                    resize: true
                },
                modes: {
                    grab: { distance: 150, line_linked: { opacity: 0.35 } },
                    push: { particles_nb: 3 }
                }
            },
            retina_detect: true
        });
    }

    /* ---------- Konami code achievement ---------- */
    var seq = [38, 38, 40, 40, 37, 39, 37, 39, 66, 65];
    var pos = 0;
    var fired = false;

    function confettiBurst() {
        var canvas = document.createElement('canvas');
        canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:99998;pointer-events:none;';
        document.body.appendChild(canvas);
        var ctx = canvas.getContext('2d');
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        var colors = ['#f9004d', '#ffb400', '#3d7bff', '#ffffff', '#2bd67b'];
        var parts = [];
        for (var i = 0; i < 160; i++) {
            parts.push({
                x: canvas.width / 2,
                y: canvas.height * 0.35,
                vx: (Math.random() - 0.5) * 16,
                vy: -Math.random() * 14 - 4,
                s: Math.random() * 7 + 3,
                c: colors[Math.floor(Math.random() * colors.length)],
                r: Math.random() * Math.PI
            });
        }
        var frames = 0;
        (function draw() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            parts.forEach(function (p) {
                p.x += p.vx; p.y += p.vy; p.vy += 0.35; p.r += 0.1;
                ctx.save();
                ctx.translate(p.x, p.y);
                ctx.rotate(p.r);
                ctx.fillStyle = p.c;
                ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6);
                ctx.restore();
            });
            if (++frames < 130) {
                requestAnimationFrame(draw);
            } else {
                canvas.remove();
            }
        })();
    }

    function showToast(html) {
        var t = document.getElementById('xp-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'xp-toast';
            document.body.appendChild(t);
        }
        t.innerHTML = html || '🏆 ACHIEVEMENT UNLOCKED — Konami Code <span class="xp">+100 XP</span>';
        requestAnimationFrame(function () { t.classList.add('show'); });
        clearTimeout(t._hideTimer);
        t._hideTimer = setTimeout(function () { t.classList.remove('show'); }, 3200);
    }
    window.pgToast = showToast;

    document.addEventListener('keydown', function (e) {
        pos = (e.keyCode === seq[pos]) ? pos + 1 : (e.keyCode === seq[0] ? 1 : 0);
        if (pos === seq.length) {
            pos = 0;
            if (!fired) {
                fired = true;
                setTimeout(function () { fired = false; }, 4000);
                confettiBurst();
                showToast();
            }
        }
    });

    /* ---------- ARRISE live AR demo gallery ---------- */
    var arDemos = [
        { img: 'assets/images/ar-targets/thevicestreets.jpg', qr: 'assets/images/ar-targets/qr-thevicestreets.svg', name: 'The Vice Streets — AR visiting card' },
        { img: 'assets/images/ar-targets/one8.jpg', qr: 'assets/images/ar-targets/qr-one8.svg', name: 'One8 — AR product poster' },
        { img: 'assets/images/ar-targets/kingofgluttony.jpg', qr: 'assets/images/ar-targets/qr-kingofgluttony.svg', name: 'King of Gluttony — AR book cover' },
        { img: 'assets/images/ar-targets/india-post.jpg', qr: 'assets/images/ar-targets/qr-india-post.svg', name: 'India Post — AR postcard' },
        { img: 'assets/images/ar-targets/fifa2026.jpg', qr: 'assets/images/ar-targets/qr-fifa2026.svg', name: 'FIFA 2026 — AR poster' }
    ];
    var adpImg = document.getElementById('adp-target');
    if (adpImg) {
        var adpZoom = document.getElementById('adp-zoom');
        var adpQr = document.getElementById('adp-qr');
        var adpName = document.getElementById('adp-name');
        var adpCount = document.getElementById('adp-count');
        var adpIdx = 0;
        var adpShow = function (i) {
            adpIdx = (i + arDemos.length) % arDemos.length;
            adpImg.src = arDemos[adpIdx].img;
            if (adpZoom) adpZoom.href = arDemos[adpIdx].img;
            if (adpQr) adpQr.src = arDemos[adpIdx].qr;
            if (adpName) adpName.textContent = arDemos[adpIdx].name;
            if (adpCount) adpCount.textContent = (adpIdx + 1) + ' / ' + arDemos.length;
        };
        var prevBtn = document.querySelector('.adp-prev');
        var nextBtn = document.querySelector('.adp-next');
        if (prevBtn) prevBtn.addEventListener('click', function () { adpShow(adpIdx - 1); });
        if (nextBtn) nextBtn.addEventListener('click', function () { adpShow(adpIdx + 1); });
        adpImg.addEventListener('error', function () {
            var panel = adpImg.closest('.ar-demo-panel');
            if (panel) panel.style.display = 'none';
        });
    }

    /* ---------- Build pipeline: CI-style stage cascade + terminal typing ----------
       No-JS / reduced-motion fallback: the HTML ships fully "passed" (green rail,
       checked dots, complete log). We only arm the animation when it can play. */
    (function () {
        var pipe = document.getElementById('build-pipeline');
        if (!pipe || !('IntersectionObserver' in window)) return;
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

        var term = document.querySelector('.bp-term-body');
        var stages = Array.prototype.slice.call(pipe.querySelectorAll('.bp-stage'));

        // capture the final build log, then blank it for the typing effect
        var lines = [];
        if (term) {
            Array.prototype.slice.call(term.querySelectorAll('.ln')).forEach(function (ln) {
                var c = ln.querySelector('.tl-caret');
                if (c) c.remove();
                lines.push({ cls: ln.className, text: ln.textContent });
            });
            term.innerHTML = '';
        }
        pipe.classList.add('bp-armed');

        var caret = document.createElement('span');
        caret.className = 'tl-caret';
        caret.textContent = '▌';

        function typeLines(i) {
            if (!term || i >= lines.length) return; // caret keeps blinking on the last line
            var span = document.createElement('span');
            span.className = lines[i].cls;
            term.appendChild(span);
            span.appendChild(caret);
            var text = lines[i].text, j = 0;
            (function tick() {
                if (j < text.length) {
                    span.insertBefore(document.createTextNode(text.charAt(j)), caret);
                    j++;
                    setTimeout(tick, 12);
                } else {
                    setTimeout(function () { typeLines(i + 1); }, 160);
                }
            })();
        }

        var played = false;
        function run() {
            if (played) return;
            played = true;
            pipe.classList.add('bp-go');
            stages.forEach(function (st, i) {
                var last = i === stages.length - 1;
                setTimeout(function () { st.classList.add('is-in', 'is-run'); }, i * 560);
                if (!last) {
                    setTimeout(function () {
                        st.classList.remove('is-run');
                        st.classList.add('is-done');
                    }, i * 560 + 500);
                }
                // the LiveOps stage stays amber & pulsing — it's ongoing, like the ▸ log line
            });
            typeLines(0);
        }

        var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (e) {
                if (e.isIntersecting) { run(); io.disconnect(); }
            });
        }, { threshold: 0.15 });
        io.observe(pipe);
    })();

    /* ---------- "Plan Your Build" estimator ---------- */
    (function () {
        var steps = document.getElementById('est-steps');
        if (!steps) return;
        var specEl = document.getElementById('est-spec');
        var weeksEl = document.getElementById('est-weeks');
        var sendEl = document.getElementById('est-send');

        function chipsOf(group) {
            return Array.prototype.slice.call(group.querySelectorAll('.est-chip'));
        }
        function onChips(group) {
            return chipsOf(group).filter(function (c) { return c.classList.contains('is-on'); });
        }

        function compute() {
            var groups = Array.prototype.slice.call(steps.querySelectorAll('.est-chips'));
            var total = 0;
            var platform = '', type = '', feats = [];
            groups.forEach(function (g) {
                onChips(g).forEach(function (c) {
                    total += parseInt(c.getAttribute('data-weeks'), 10) || 0;
                    var label = c.getAttribute('data-label');
                    var kind = g.getAttribute('data-est');
                    if (kind === 'platform') platform = label;
                    else if (kind === 'type') type = label;
                    else feats.push(label);
                });
            });
            var low = total;
            var high = Math.ceil(total * 1.35);
            if (high <= low) high = low + 2;

            // spec list
            var items = [
                '<li><b>' + type + '</b></li>',
                '<li>on ' + platform + '</li>'
            ];
            feats.forEach(function (f) { items.push('<li class="est-spec-feat">+ ' + f + '</li>'); });
            if (!feats.length) items.push('<li class="est-spec-feat">+ core gameplay only (add features anytime)</li>');
            specEl.innerHTML = items.join('');
            weeksEl.textContent = low + '–' + high;

            var msg = 'Hi Aman! I planned a project on your portfolio:\n'
                + '▸ ' + type + '\n'
                + '▸ Platform: ' + platform + '\n'
                + (feats.length ? '▸ Features: ' + feats.join(', ') + '\n' : '')
                + '▸ Your ballpark: ' + low + '–' + high + ' weeks\n'
                + "Let's talk!";
            sendEl.href = 'https://wa.me/919560448788?text=' + encodeURIComponent(msg);
        }

        steps.addEventListener('click', function (e) {
            var chip = e.target.closest ? e.target.closest('.est-chip') : null;
            if (!chip) return;
            var group = chip.parentElement;
            var kind = group.getAttribute('data-est');
            if (kind === 'features') {
                chip.classList.toggle('is-on');
                chip.setAttribute('aria-pressed', chip.classList.contains('is-on') ? 'true' : 'false');
            } else {
                if (chip.classList.contains('is-on')) return; // radio: one always stays on
                chipsOf(group).forEach(function (c) {
                    c.classList.remove('is-on');
                    c.setAttribute('aria-pressed', 'false');
                });
                chip.classList.add('is-on');
                chip.setAttribute('aria-pressed', 'true');
            }
            compute();
        });

        compute();
    })();

    /* ---------- "Why Hire Me" proof links: smooth-scroll to the evidence.
       Scoped to .wh-proof so the jQuery one-page nav keeps its own scrolling. */
    (function () {
        var links = Array.prototype.slice.call(document.querySelectorAll('a.wh-proof[href^="#"]'));
        if (!links.length) return;
        var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        links.forEach(function (a) {
            a.addEventListener('click', function (e) {
                var target = document.getElementById(a.getAttribute('href').slice(1));
                if (!target) return; // let the browser handle it
                e.preventDefault();
                target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
            });
        });
    })();

    if (window.console && console.log) {
        console.log('%c🎮 psst… try the Konami code: ↑ ↑ ↓ ↓ ← → ← → B A', 'color:#f9004d;font-weight:bold;font-size:13px;');
    }
})();

/* ============================================================
   Neon chip: a short electric buzz when the pointer lands on the
   "OPEN" sign in the header. Browsers only let audio start after
   a click/tap/keypress, so it stays silent until the page has had
   one, and it respects the mute chosen in the neon room.
   ============================================================ */
(function () {
    'use strict';
    var chip = document.querySelector('.neon-chip');
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!chip || !AC || !window.matchMedia || !window.matchMedia('(hover: hover)').matches) return;
    var ac = null, noiseBuf = null, armed = false, last = 0;
    function arm() { armed = true; }
    ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
        document.addEventListener(ev, arm, { once: true, passive: true });
    });
    function muted() {
        try { return localStorage.getItem('neon-sound') === '0'; } catch (e) { return false; }
    }
    function zap() {
        var active = armed || (navigator.userActivation && navigator.userActivation.hasBeenActive);
        if (!active || muted()) return;
        if (!ac) {
            try { ac = new AC(); } catch (e) { return; }
            var len = ac.sampleRate;
            noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
            var d = noiseBuf.getChannelData(0);
            for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        }
        if (ac.state === 'suspended') ac.resume();
        var t0 = ac.currentTime, dur = 0.42;
        if (t0 - last < 0.25) return;
        last = t0;
        var env = ac.createGain();
        env.gain.setValueAtTime(0.0001, t0);
        env.gain.exponentialRampToValueAtTime(0.08, t0 + 0.04);
        env.gain.setValueAtTime(0.08, t0 + 0.2);
        env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        env.connect(ac.destination);
        /* mains-gated sizzle */
        var src = ac.createBufferSource();
        src.buffer = noiseBuf; src.loop = true;
        var bp = ac.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 1;
        var gate = ac.createGain(), lfo = ac.createOscillator(), lg = ac.createGain();
        gate.gain.value = 0.5; lfo.type = 'square'; lfo.frequency.value = 100; lg.gain.value = 0.5;
        lfo.connect(lg); lg.connect(gate.gain);
        src.connect(bp); bp.connect(gate); gate.connect(env);
        /* harmonic rasp */
        var saw = ac.createOscillator(), hp = ac.createBiquadFilter(), sg = ac.createGain();
        saw.type = 'sawtooth'; saw.frequency.value = 120; hp.type = 'highpass'; hp.frequency.value = 700; sg.gain.value = 0.35;
        saw.connect(hp); hp.connect(sg); sg.connect(env);
        src.start(t0); lfo.start(t0); saw.start(t0);
        src.stop(t0 + dur + 0.05); lfo.stop(t0 + dur + 0.05); saw.stop(t0 + dur + 0.05);
    }
    chip.addEventListener('pointerenter', zap);
})();
