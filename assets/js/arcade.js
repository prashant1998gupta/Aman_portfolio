/* ============================================================
   The Mini Arcade — core engine
   Owns: canvas, loop, input, tabs, score/best, particles, shake.
   Games register via window.ARCADE.register(module).
   ============================================================ */
(function () {
    'use strict';

    var games = {}, order = [];

    window.ARCADE = {
        register: function (g) {
            if (!games[g.id]) order.push(g.id);
            games[g.id] = g;
        }
    };

    document.addEventListener('DOMContentLoaded', function () {
        var canvas = document.getElementById('physics-canvas');
        if (!canvas) return;
        var ctx = canvas.getContext('2d', { desynchronized: true });
        var wrap = canvas.parentElement;
        var tabsEl = document.getElementById('arcade-tabs');
        var controlsEl = document.getElementById('arcade-controls');
        var hintEl = document.getElementById('arcade-hint');
        var scoreWrapEl = document.getElementById('arcade-scorewrap');
        var scoreLabelEl = document.getElementById('arcade-scorelabel');
        var scoreEl = document.getElementById('arcade-score');
        var bestWrapEl = document.getElementById('arcade-bestwrap');
        var bestEl = document.getElementById('arcade-best');

        var DPR = 1;
        var W = 0, H = 0;
        var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        var active = null, state = 'play', score = 0, overLabel = 'GAME OVER';
        var particles = [], shakeT = 0, shakePow = 0;
        var visible = false, running = false, last = 0;
        var playedSet = {}, playedCount = 0, hopperDone = false;

        var isCoarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
        var canVibrate = 'vibrate' in navigator;
        var hudEl = wrap.querySelector('.play-hud');
        /* Touch steering: games with `steer: true` are driven by a virtual
           pointer — relative "trackpad" drags (boosted) or device tilt —
           so a finger never has to sit on top of the action. */
        var virt = { x: 0, y: 0 };
        var steerTouch = null;
        var TOUCH_SENS = 1.55;
        var tiltOn = false, tiltHooked = false, tiltZero = null, tiltLast = null;
        var pseudoFs = false;
        var hireEl = null, deaths = 0, hireShown = false;

        /* ----- Leaderboard: disabled on this build (no backend) — high scores stay on this device ----- */
        var LB_ENABLED = false;
        var LB_BAD = { ASS: 1, FUK: 1, FUC: 1, FCK: 1, SEX: 1, TIT: 1, CUM: 1, DIK: 1, DIC: 1, COK: 1, KKK: 1, FAG: 1, GAY: 1, NIG: 1, POO: 1, PEE: 1 };
        var lb = {
            fb: null, loading: null, offline: false, uid: null,
            cache: {},
            subBest: {},
            initials: (localStorage.getItem('arcade-initials') || 'AAA').split('')
        };
        try { lb.subBest = JSON.parse(localStorage.getItem('arcade-lb-sub') || '{}'); } catch (e) { lb.subBest = {}; }
        function saveSubBest() { localStorage.setItem('arcade-lb-sub', JSON.stringify(lb.subBest)); }

        function lbLoad() {
            lb.offline = true;
            return Promise.reject(new Error('leaderboard disabled'));
        }
        function lbTop(game, force) {
            var c = lb.cache[game];
            if (!force && c && (Date.now() - c.t) < 60000) return Promise.resolve(c.rows);
            return lbLoad().then(function (fb) {
                var q = fb.fs.query(
                    fb.fs.collection(fb.db, 'lb', game, 'scores'),
                    fb.fs.orderBy('score', 'desc'),
                    fb.fs.limit(10)
                );
                return fb.fs.getDocs(q).then(function (snap) {
                    var rows = [];
                    snap.forEach(function (d) {
                        var v = d.data();
                        rows.push({ id: d.id, initials: String(v.initials || '???').slice(0, 3), score: v.score | 0 });
                    });
                    lb.cache[game] = { t: Date.now(), rows: rows };
                    lb.offline = false;
                    return rows;
                });
            });
        }
        function lbSubmit(game, initials, sc) {
            return lbLoad().then(function (fb) {
                var ref = fb.fs.doc(fb.fs.collection(fb.db, 'lb', game, 'scores'), lb.uid);
                return fb.fs.setDoc(ref, {
                    initials: initials, score: sc, createdAt: fb.fs.serverTimestamp()
                }).then(function () {
                    lb.subBest[game] = Math.max(lb.subBest[game] || 0, sc);
                    saveSubBest();
                    localStorage.setItem('arcade-initials', initials);
                    return lb.uid;
                });
            });
        }

        /* entry/board UI state */
        /* per-game briefing shown on the start screen */
        var INFO = {
            sandbox: { goal: 'A physics toy — no score, no fail. Just play.',
                how: ['Click or tap empty space to spawn objects', 'Drag an object and let go to fling it', 'Switch gravity: Earth · Moon · Zero-G'] },
            stack:   { goal: 'Stack the tower as high as you can.',
                how: ['Click / tap to drop the moving block', 'Overhang gets sliced off — the block shrinks', 'Land it dead centre for a PERFECT and bonus width'] },
            runner:  { goal: 'Run as far as you can without hitting a lag spike.',
                how: ['Click / tap / Space to jump — twice for a double jump', 'Red spikes = lag. Tall blue blocks = memory leaks', 'Speed keeps climbing, so does your score'] },
            bugs:    { goal: 'Protect build.exe from the bugs.',
                how: ['Click / tap a bug to squash it', 'Bugs that reach the build drop its integrity', 'Fast successive squashes build a combo — gold bugs are worth 5'] },
            dodge:   { goal: 'Survive the asteroid field as long as you can.',
                how: ['Move the pointer (or drag / tilt on mobile) to steer', 'Score climbs while you survive', 'Skim past an asteroid for a graze bonus · grab shields'] },
            memory:  { goal: 'Match all 8 pairs of my tech stack.',
                how: ['Flip two cards — matching pairs stay face up', 'Fewer moves and less time = higher score', 'Clear all 8 pairs to win'] },
            catcher: { goal: 'Catch the commits, dodge the conflicts.',
                how: ['Move the pointer to slide the branch basket', 'Green commits = +1 · missing one costs a life', 'NEVER catch a red merge conflict · gold hotfix = +5 and a life'] },
            leak:    { goal: 'Pop memory leaks before the RAM meter fills.',
                how: ['Click / tap a leak to free its memory', 'Bigger leaks are worth more — but they fill RAM faster', 'Avoid the spiky red NullRefs — they cost points'] },
            pong:    { goal: 'Return the packet. Beat the server — or a friend.',
                how: ['Move the pointer (or drag / tilt) to move your paddle', 'Every return speeds the packet up and scores +1', 'Beat the server for a real-time online 1v1'] },
            blaster: { goal: 'Clear the spam waves before they reach the firewall.',
                how: ['Move the pointer to steer — you auto-fire', 'Dodge the red spam mail they shoot back', 'Golden UNSUBSCRIBE bot = +5 and clears all spam'] }
        };

        var entry = { slot: 0, busy: false, err: 0 };
        var board = { rows: null, status: 'loading', returnTo: 'over', justSubmitted: false };

        function showHire() {
            if (!hireEl) return;
            hireEl.style.bottom = ((hudEl ? hudEl.offsetHeight : 0) + 16) + 'px';
            hireEl.classList.add('show');
        }
        function hideHire() { if (hireEl) hireEl.classList.remove('show'); }

        function clampN(v, a, b) { return v < a ? a : (v > b ? b : v); }
        function usesSteer() { return !!(active && active.steer); }
        function buzz(pattern) { if (canVibrate) { try { navigator.vibrate(pattern); } catch (err) {} } }

        function toast(msg) { if (window.pgToast) window.pgToast(msg); buzz(25); }

        var api = {
            W: 0, H: 0,
            colors: {
                accent: '#f9004d', accent2: '#ff3d71', blue: '#3d7bff',
                gold: '#ffb400', green: '#2bd67b', ink: '#0b1120',
                white: '#e8ecf3', muted: '#8a93a5'
            },
            pointer: { x: 0, y: 0, down: false },
            rand: function (a, b) { return a + Math.random() * (b - a); },
            roundRect: function (c, x, y, w, h, r) {
                r = Math.min(r, w / 2, h / 2);
                c.beginPath();
                c.moveTo(x + r, y);
                c.arcTo(x + w, y, x + w, y + h, r);
                c.arcTo(x + w, y + h, x, y + h, r);
                c.arcTo(x, y + h, x, y, r);
                c.arcTo(x, y, x + w, y, r);
                c.closePath();
            },
            setScore: function (n) {
                score = Math.round(n);
                if (scoreEl) scoreEl.textContent = score;
            },
            gameOver: function (finalScore, label) {
                if (state !== 'play') return;
                buzz(60);
                deaths++;
                overLabel = label || 'GAME OVER';
                api.setScore(finalScore || score);
                var key = 'arcade-best-' + active.id;
                var best = parseInt(localStorage.getItem(key) || '0', 10);
                if (score > best) {
                    localStorage.setItem(key, String(score));
                    if (best > 0) toast('🏆 New high score on ' + active.name + '! <span class="xp">+15 XP</span>');
                    for (var i = 0; i < 30; i++) api.spawnParticles(api.W / 2, api.H / 3, api.colors.gold, 1);
                }
                updateBest();
                if (LB_ENABLED && !active.noScore && score > 0 && score > (lb.subBest[active.id] || 0)) {
                    entry.slot = 0; entry.busy = false; entry.err = 0;
                    state = 'entry';
                } else if (LB_ENABLED && !active.noScore) {
                    openBoard('over');
                } else {
                    state = 'over';
                }
            },
            toast: toast,
            buzz: buzz,
            spawnParticles: function (x, y, color, count) {
                for (var i = 0; i < (count || 8); i++) {
                    if (particles.length > 220) particles.shift();
                    particles.push({
                        x: x, y: y,
                        vx: (Math.random() - 0.5) * 340,
                        vy: (Math.random() - 0.5) * 340 - 60,
                        life: 0.55 + Math.random() * 0.35,
                        t: 0, color: color, size: 2 + Math.random() * 4
                    });
                }
            },
            shake: function (power) { if (reduceMotion) return; shakeT = 0.32; shakePow = power || 6; },
            forcePlay: function () { if (state === 'intro' || state === 'paused') { state = 'play'; updatePauseUI(); } }
        };

        function resize() {
            W = wrap.clientWidth;
            if (wrap.classList.contains('is-fs')) {
                // fullscreen: canvas takes everything above the HUD (minus safe-area padding)
                var cs = window.getComputedStyle(wrap);
                var padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
                var hudH = hudEl ? hudEl.offsetHeight : 0;
                H = Math.max(240, wrap.clientHeight - padV - hudH);
            } else {
                // taller canvas on phones: falling/shooter games need vertical room
                H = W < 520 ? Math.round(Math.min(460, W * 1.15)) : Math.max(320, Math.min(480, Math.round(W * 0.48)));
            }
            DPR = Math.min(window.devicePixelRatio || 1, W < 520 ? 1.5 : 2);
            canvas.width = W * DPR;
            canvas.height = H * DPR;
            canvas.style.height = H + 'px';
            ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
            api.W = W; api.H = H;
        }
        resize();
        window.addEventListener('resize', resize);
        window.addEventListener('load', resize);

        function updateBest() {
            if (!active) return;
            if (active.noScore) { if (bestWrapEl) bestWrapEl.style.display = 'none'; return; }
            var best = parseInt(localStorage.getItem('arcade-best-' + active.id) || '0', 10);
            if (bestWrapEl) bestWrapEl.style.display = best > 0 ? '' : 'none';
            if (bestEl) bestEl.textContent = best;
        }

        function requestTilt(done) {
            var D = window.DeviceOrientationEvent;
            function hook() {
                if (!tiltHooked) {
                    tiltHooked = true;
                    window.addEventListener('deviceorientation', function (e) {
                        if (e.beta == null || e.gamma == null) return;
                        tiltLast = { beta: e.beta, gamma: e.gamma };
                    });
                }
                done(true);
            }
            if (D && typeof D.requestPermission === 'function') {
                // iOS 13+: must be called from a user gesture
                D.requestPermission().then(function (r) {
                    if (r === 'granted') hook(); else done(false);
                }).catch(function () { done(false); });
            } else if (D) {
                hook();
            } else {
                done(false);
            }
        }

        function canPause() {
            return !(active && active.onlineActive && active.onlineActive());
        }
        function updatePauseUI() {
            var pb = hudEl && hudEl.querySelector('.play-pause-btn');
            if (!pb) return;
            pb.style.display = canPause() ? '' : 'none';
            pb.textContent = (state === 'paused') ? '▶ Resume' : '⏸ Pause';
        }
        function setPaused(on) {
            if (on && state === 'play' && canPause()) { state = 'paused'; }
            else if (!on && state === 'paused') { state = 'play'; }
            updatePauseUI();
        }
        function startPlay() {
            state = 'play';
            updatePauseUI();
        }

        function openBoard(returnTo) {
            board.returnTo = returnTo;
            board.status = 'loading';
            board.rows = null;
            state = 'board';
            // hiring hook shows with the board, never over the initials entry
            if (!hireShown && deaths >= 2) { hireShown = true; showHire(); }
            lbTop(active.id, board.justSubmitted).then(function (rows) {
                board.rows = rows;
                board.status = 'ok';
                board.justSubmitted = false;
                if (lb.uid) {
                    for (var i = 0; i < rows.length; i++) {
                        if (rows[i].id === lb.uid && rows[i].score > (lb.subBest[active.id] || 0)) {
                            lb.subBest[active.id] = rows[i].score;
                            saveSubBest();
                        }
                    }
                }
            }).catch(function () {
                board.status = 'offline';
                board.justSubmitted = false;
            });
        }
        function boardProceed() {
            hideHire();
            if (board.returnTo === 'play') { state = 'play'; return; }
            restartActive();
        }
        function submitEntry() {
            if (entry.busy) return;
            var ini = lb.initials.join('');
            if (LB_BAD[ini]) { entry.err = 1; buzz([40, 40, 40]); return; }
            entry.busy = true;
            var sc = score, g = active.id;
            lbSubmit(g, ini, sc).then(function () {
                entry.busy = false;
                board.justSubmitted = true;
                if (!localStorage.getItem('arcade-lb-first')) {
                    localStorage.setItem('arcade-lb-first', '1');
                    toast('🏆 On the worldwide board! <span class="xp">+20 XP</span>');
                }
                openBoard('over');
            }).catch(function (err) {
                entry.busy = false;
                if (err && err.code === 'permission-denied') {
                    // our older entry on the server is better - remember that
                    lb.subBest[g] = Math.max(lb.subBest[g] || 0, sc);
                    saveSubBest();
                } else {
                    lb.offline = true;
                }
                openBoard('over');
            });
        }

        function renderControls() {
            if (!controlsEl) return;
            controlsEl.innerHTML = '';
            (active.controls || []).forEach(function (c) {
                var b = document.createElement('button');
                b.type = 'button';
                if (c.primary) b.className = 'primary';
                b.textContent = (typeof c.label === 'function') ? c.label() : c.label;
                b.addEventListener('click', function () {
                    c.onClick(api);
                    b.textContent = (typeof c.label === 'function') ? c.label() : c.label;
                });
                controlsEl.appendChild(b);
            });
            if (active.steer && isCoarse && window.DeviceOrientationEvent) {
                var tb = document.createElement('button');
                tb.type = 'button';
                tb.className = 'tilt-btn' + (tiltOn ? ' on' : '');
                tb.textContent = tiltOn ? '🧭 Tilt ON' : '🧭 Tilt';
                tb.addEventListener('click', function () {
                    if (tiltOn) {
                        tiltOn = false;
                        tb.classList.remove('on');
                        tb.textContent = '🧭 Tilt';
                        return;
                    }
                    requestTilt(function (ok) {
                        if (!ok) { toast('🧭 Tilt not available on this device'); return; }
                        tiltOn = true;
                        tiltZero = null; // recalibrate to how the phone is held right now
                        tb.classList.add('on');
                        tb.textContent = '🧭 Tilt ON';
                        toast('🧭 Tilt ON — hold comfy, tilt to steer');
                    });
                });
                controlsEl.appendChild(tb);
            }
        }

        function select(id) {
            var g = games[id];
            if (!g) return;
            active = g;
            state = 'play';
            particles.length = 0;
            api.setScore(0);
            hideHire();
            if (hintEl) hintEl.textContent = (isCoarse && g.hintTouch) ? g.hintTouch : (g.hint || '');
            if (scoreWrapEl) scoreWrapEl.style.display = g.noScore ? 'none' : '';
            var lbb = hudEl && hudEl.querySelector('.play-lb-btn');
            if (lbb) lbb.style.display = (g.noScore || g.noBoard) ? 'none' : '';
            if (scoreLabelEl) scoreLabelEl.textContent = g.scoreLabel || 'Score';
            updateBest();
            renderControls();
            Array.prototype.forEach.call(tabsEl.children, function (t) {
                t.classList.toggle('active', t.dataset.game === id);
            });
            // keep the active tab visible in the mobile scroll strip
            var at = tabsEl.querySelector('button.active');
            if (at && tabsEl.scrollWidth > tabsEl.clientWidth + 4) {
                tabsEl.scrollTo({ left: at.offsetLeft - (tabsEl.clientWidth - at.offsetWidth) / 2, behavior: 'smooth' });
            }
            virt.x = W / 2; virt.y = H * 0.6;
            g.start(api);
            state = 'intro';
            updatePauseUI();
            if (!playedSet[id]) {
                playedSet[id] = true;
                playedCount++;
                if (playedCount === 3 && !hopperDone) {
                    hopperDone = true;
                    toast('🏆 Game hopper — 3 games tried <span class="xp">+25 XP</span>');
                }
                if (playedCount === order.length && order.length >= 10) {
                    toast('🏆 FULL CLEAR — every game tried <span class="xp">+50 XP</span>');
                }
            }
        }

        function buildTabs() {
            if (!tabsEl) return;
            order.forEach(function (id) {
                var g = games[id];
                var b = document.createElement('button');
                b.type = 'button';
                b.dataset.game = id;
                b.innerHTML = '<span class="ico">' + (g.icon || '🎮') + '</span> ' + g.name;
                b.addEventListener('click', function () { select(id); });
                tabsEl.appendChild(b);
            });
        }

        function pos(e) {
            var rect = canvas.getBoundingClientRect();
            return { x: e.clientX - rect.left, y: e.clientY - rect.top };
        }
        function restartActive() {
            if (!active) return;
            state = 'play';
            particles.length = 0;
            api.setScore(0);
            hideHire();
            virt.x = W / 2; virt.y = H * 0.6;
            active.start(api);
            state = 'play';
            updatePauseUI();
        }
        canvas.addEventListener('pointerdown', function (e) {
            e.preventDefault();
            var p = pos(e);
            if (active.blocksPlay && active.blocksPlay()) {
                if (active.pointerDown) active.pointerDown(p, api);
                return;
            }
            if (state === 'over') { restartActive(); return; }
            if (state === 'entry') { entryTap(p); return; }
            if (state === 'board') { boardProceed(); return; }
            if (state === 'intro') { startPlay(); return; }
            if (state === 'paused') { setPaused(false); return; }
            if (e.pointerType === 'touch' && usesSteer() && !tiltOn) {
                // trackpad mode: anchor the drag, the virtual pointer stays where it was
                steerTouch = { fx: p.x, fy: p.y, vx: virt.x, vy: virt.y };
                api.pointer.x = virt.x; api.pointer.y = virt.y; api.pointer.down = true;
                if (active.pointerDown) active.pointerDown({ x: virt.x, y: virt.y }, api);
                return;
            }
            virt.x = p.x; virt.y = p.y;
            api.pointer.x = p.x; api.pointer.y = p.y; api.pointer.down = true;
            if (active.pointerDown) active.pointerDown(p, api);
        });
        window.addEventListener('pointermove', function (e) {
            if (e.pointerType === 'touch' && usesSteer()) {
                if (!steerTouch || tiltOn) return;
                var f = pos(e);
                virt.x = clampN(steerTouch.vx + (f.x - steerTouch.fx) * TOUCH_SENS, 0, W);
                virt.y = clampN(steerTouch.vy + (f.y - steerTouch.fy) * TOUCH_SENS, 0, H);
                api.pointer.x = virt.x; api.pointer.y = virt.y;
                if (active && state === 'play' && active.pointerMove) active.pointerMove({ x: virt.x, y: virt.y }, api);
                return;
            }
            var p = pos(e);
            virt.x = p.x; virt.y = p.y;
            api.pointer.x = p.x; api.pointer.y = p.y;
            if (active && state === 'play' && active.pointerMove) active.pointerMove(p, api);
        });
        window.addEventListener('pointerup', function () {
            steerTouch = null;
            api.pointer.down = false;
            if (active && state === 'play' && active.pointerUp) active.pointerUp({ x: api.pointer.x, y: api.pointer.y }, api);
        });
        window.addEventListener('pointercancel', function () {
            steerTouch = null;
            api.pointer.down = false;
        });
        document.addEventListener('keydown', function (e) {
            if (!visible || !active) return;
            var tag = (document.activeElement && document.activeElement.tagName) || '';
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            if (active.blocksPlay && active.blocksPlay()) {
                if (active.keyDown) active.keyDown(e.key, api);
                if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].indexOf(e.key) !== -1) e.preventDefault();
                return;
            }
            if (state === 'entry') {
                var k = e.key;
                if (/^[a-zA-Z]$/.test(k)) {
                    lb.initials[entry.slot] = k.toUpperCase();
                    entry.slot = Math.min(2, entry.slot + 1);
                    entry.err = 0;
                    e.preventDefault();
                } else if (k === 'Backspace' || k === 'ArrowLeft') {
                    entry.slot = Math.max(0, entry.slot - 1);
                    e.preventDefault();
                } else if (k === 'ArrowRight') {
                    entry.slot = Math.min(2, entry.slot + 1);
                    e.preventDefault();
                } else if (k === 'ArrowUp' || k === 'ArrowDown') {
                    var d = k === 'ArrowUp' ? 1 : -1;
                    var code = lb.initials[entry.slot].charCodeAt(0) - 65;
                    lb.initials[entry.slot] = String.fromCharCode(65 + ((code + d + 26) % 26));
                    e.preventDefault();
                } else if (k === 'Enter') {
                    submitEntry();
                    e.preventDefault();
                } else if (k === 'Escape') {
                    openBoard('over');
                    e.preventDefault();
                }
                return;
            }
            if (state === 'board') {
                if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') {
                    boardProceed();
                    e.preventDefault();
                }
                return;
            }
            if (state === 'intro') {
                if (e.key === ' ' || e.key === 'Enter') { startPlay(); e.preventDefault(); }
                return;
            }
            if (state === 'paused') {
                if (e.key === ' ' || e.key === 'Enter' || e.key === 'p' || e.key === 'P' || e.key === 'Escape') {
                    setPaused(false); e.preventDefault();
                }
                return;
            }
            if (state === 'play' && (e.key === 'p' || e.key === 'P' || e.key === 'Escape')) {
                setPaused(true); e.preventDefault(); return;
            }
            if (!active.keyDown || state !== 'play') return;
            active.keyDown(e.key, api);
            if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].indexOf(e.key) !== -1) e.preventDefault();
        });

        function stepParticles(dt) {
            for (var i = particles.length - 1; i >= 0; i--) {
                var p = particles[i];
                p.t += dt;
                if (p.t >= p.life) { particles.splice(i, 1); continue; }
                p.x += p.vx * dt;
                p.y += p.vy * dt;
                p.vy += 700 * dt;
            }
        }
        function drawParticles() {
            for (var i = 0; i < particles.length; i++) {
                var p = particles[i];
                ctx.globalAlpha = 1 - p.t / p.life;
                ctx.fillStyle = p.color;
                ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
            }
            ctx.globalAlpha = 1;
        }

        function entryLayout() {
            var slotW = Math.min(64, W * 0.14), gap = Math.min(18, W * 0.04);
            var totalW = slotW * 3 + gap * 2;
            var x0 = (W - totalW) / 2;
            var cy = H / 2 + 14;
            var slots = [];
            for (var i = 0; i < 3; i++) {
                var x = x0 + i * (slotW + gap);
                slots.push({ x: x, y: cy - slotW * 0.62, w: slotW, h: slotW * 1.24 });
            }
            var btnW = Math.min(190, W * 0.42), btnH = 42;
            return {
                slots: slots, slotW: slotW,
                submit: { x: W / 2 - btnW / 2, y: cy + slotW * 0.85, w: btnW, h: btnH },
                skip: { x: W / 2 - 70, y: cy + slotW * 0.85 + btnH + 8, w: 140, h: 30 }
            };
        }
        function entryTap(p) {
            if (entry.busy) return;
            var L = entryLayout();
            for (var i = 0; i < 3; i++) {
                var sl = L.slots[i];
                // above the slot = letter up, below = letter down, on it = select
                if (p.x >= sl.x - 6 && p.x <= sl.x + sl.w + 6) {
                    if (p.y >= sl.y - 34 && p.y < sl.y) {
                        entry.slot = i; bumpLetter(i, 1); return;
                    }
                    if (p.y > sl.y + sl.h && p.y <= sl.y + sl.h + 34) {
                        entry.slot = i; bumpLetter(i, -1); return;
                    }
                    if (p.y >= sl.y && p.y <= sl.y + sl.h) { entry.slot = i; return; }
                }
            }
            var b = L.submit;
            if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) { submitEntry(); return; }
            var k = L.skip;
            if (p.x >= k.x && p.x <= k.x + k.w && p.y >= k.y && p.y <= k.y + k.h) { openBoard('over'); return; }
        }
        function bumpLetter(i, d) {
            var code = lb.initials[i].charCodeAt(0) - 65;
            lb.initials[i] = String.fromCharCode(65 + ((code + d + 26) % 26));
            entry.err = 0;
            buzz(10);
        }
        function veil() {
            ctx.fillStyle = 'rgba(7,10,20,0.86)';
            ctx.fillRect(0, 0, W, H);
        }
        function fitFont(txt, weight, size, maxW) {
            ctx.font = weight + ' ' + size + 'px Montserrat, sans-serif';
            var w = ctx.measureText(txt).width;
            if (w > maxW) ctx.font = weight + ' ' + Math.max(14, Math.floor(size * maxW / w)) + 'px Montserrat, sans-serif';
        }
        function drawEntry() {
            veil();
            ctx.textAlign = 'center';
            ctx.fillStyle = overLabel === 'YOU WIN!' ? api.colors.green : api.colors.accent;
            fitFont(overLabel, '800', 34, W - 44);
            ctx.fillText(overLabel, W / 2, H * 0.18);
            ctx.fillStyle = api.colors.white;
            ctx.font = '700 22px Montserrat, sans-serif';
            ctx.fillText('Score: ' + score, W / 2, H * 0.18 + 32);
            ctx.fillStyle = api.colors.muted;
            ctx.font = '700 12px Montserrat, sans-serif';
            ctx.fillText('ENTER YOUR INITIALS — WORLDWIDE BOARD', W / 2, H / 2 - 58);
            var L = entryLayout();
            var t = performance.now() / 300;
            for (var i = 0; i < 3; i++) {
                var sl = L.slots[i];
                var on = i === entry.slot;
                ctx.fillStyle = entry.err ? 'rgba(249,0,77,0.25)' : (on ? 'rgba(249,0,77,0.14)' : 'rgba(255,255,255,0.05)');
                api.roundRect(ctx, sl.x, sl.y, sl.w, sl.h, 10);
                ctx.fill();
                ctx.strokeStyle = on ? api.colors.accent : 'rgba(255,255,255,0.25)';
                ctx.lineWidth = on ? 2.5 : 1.5;
                api.roundRect(ctx, sl.x, sl.y, sl.w, sl.h, 10);
                ctx.stroke();
                ctx.fillStyle = api.colors.white;
                ctx.font = '800 ' + Math.round(L.slotW * 0.62) + 'px Montserrat, sans-serif';
                ctx.fillText(lb.initials[i], sl.x + sl.w / 2, sl.y + sl.h / 2 + L.slotW * 0.22);
                ctx.fillStyle = on ? api.colors.accent : api.colors.muted;
                ctx.globalAlpha = on ? (0.7 + 0.3 * Math.sin(t)) : 0.5;
                ctx.font = '700 15px Montserrat, sans-serif';
                ctx.fillText('▲', sl.x + sl.w / 2, sl.y - 12);
                ctx.fillText('▼', sl.x + sl.w / 2, sl.y + sl.h + 24);
                ctx.globalAlpha = 1;
            }
            var b = L.submit;
            var grad = ctx.createLinearGradient(b.x, 0, b.x + b.w, 0);
            grad.addColorStop(0, '#ff3d71'); grad.addColorStop(1, '#f9004d');
            ctx.fillStyle = entry.busy ? 'rgba(255,255,255,0.15)' : grad;
            api.roundRect(ctx, b.x, b.y, b.w, b.h, 21);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.font = '800 15px Montserrat, sans-serif';
            ctx.fillText(entry.busy ? 'SAVING…' : 'SUBMIT SCORE', b.x + b.w / 2, b.y + 27);
            var k = L.skip;
            ctx.fillStyle = api.colors.muted;
            ctx.font = '700 12px Montserrat, sans-serif';
            ctx.fillText('SKIP', k.x + k.w / 2, k.y + 20);
            ctx.textAlign = 'left';
        }
        function drawBoard() {
            veil();
            ctx.textAlign = 'center';
            ctx.fillStyle = api.colors.gold;
            fitFont('🏆 TOP 10 — ' + active.name.toUpperCase(), '800', 22, W - 40);
            ctx.fillText('🏆 TOP 10 — ' + active.name.toUpperCase(), W / 2, 40);
            var listX0 = Math.max(24, W / 2 - 240), listX1 = Math.min(W - 24, W / 2 + 240);
            var topY = 62;
            var footH = 78;
            var rowH = clampN((H - topY - footH) / 10, 15, 30);
            var fs = Math.round(clampN(rowH * 0.62, 10, 16));
            if (board.status === 'loading') {
                ctx.fillStyle = api.colors.muted;
                ctx.globalAlpha = 0.6 + 0.4 * Math.sin(performance.now() / 250);
                ctx.font = '700 15px Montserrat, sans-serif';
                ctx.fillText('LOADING WORLDWIDE SCORES…', W / 2, H / 2);
                ctx.globalAlpha = 1;
            } else if (board.status === 'offline') {
                ctx.fillStyle = api.colors.muted;
                ctx.font = '700 14px Montserrat, sans-serif';
                ctx.fillText('LEADERBOARD OFFLINE — SCORE SAVED ON THIS DEVICE', W / 2, H / 2 - 10);
            } else if (board.rows && board.rows.length === 0) {
                ctx.fillStyle = api.colors.white;
                ctx.font = '700 15px Montserrat, sans-serif';
                ctx.fillText('NO SCORES YET — BE THE FIRST!', W / 2, H / 2 - 10);
            } else if (board.rows) {
                for (var i = 0; i < board.rows.length; i++) {
                    var r = board.rows[i];
                    var y = topY + i * rowH + rowH * 0.72;
                    var isMe = lb.uid && r.id === lb.uid;
                    if (isMe) {
                        ctx.fillStyle = 'rgba(249,0,77,0.16)';
                        api.roundRect(ctx, listX0 - 8, topY + i * rowH + 1, (listX1 - listX0) + 16, rowH - 2, 6);
                        ctx.fill();
                    }
                    ctx.font = (isMe ? '800 ' : '600 ') + fs + 'px Montserrat, sans-serif';
                    ctx.textAlign = 'left';
                    ctx.fillStyle = i === 0 ? api.colors.gold : (isMe ? api.colors.white : api.colors.muted);
                    ctx.fillText((i + 1) + '.', listX0, y);
                    ctx.fillStyle = isMe ? api.colors.accent2 : api.colors.white;
                    ctx.fillText(r.initials + (isMe ? '  ← YOU' : ''), listX0 + fs * 2.2, y);
                    ctx.textAlign = 'right';
                    ctx.fillStyle = i === 0 ? api.colors.gold : api.colors.white;
                    ctx.fillText(String(r.score), listX1, y);
                }
                ctx.textAlign = 'center';
            }
            // footer: local best + goal + proceed hint
            var best = parseInt(localStorage.getItem('arcade-best-' + active.id) || '0', 10);
            var fy = H - footH + 18;
            ctx.textAlign = 'center';
            ctx.fillStyle = api.colors.muted;
            ctx.font = '600 13px Montserrat, sans-serif';
            var line = 'Your best: ' + best;
            if (board.status === 'ok' && board.rows && board.rows.length >= 10) {
                var onBoard = board.rows.some(function (r) { return lb.uid && r.id === lb.uid; });
                if (!onBoard) line += '  ·  Top 10 needs ' + (board.rows[9].score + 1) + '+';
            }
            ctx.fillText(line, W / 2, fy);
            var pulse = 0.6 + 0.4 * Math.sin(performance.now() / 300);
            ctx.globalAlpha = pulse;
            ctx.fillStyle = api.colors.white;
            ctx.font = '700 14px Montserrat, sans-serif';
            ctx.fillText(board.returnTo === 'play' ? 'TAP TO CLOSE' : 'TAP TO PLAY AGAIN', W / 2, fy + 30);
            ctx.globalAlpha = 1;
            ctx.textAlign = 'left';
        }

        function wrapLines(txt, maxW) {
            var words = txt.split(' '), lines = [], cur = '';
            for (var i = 0; i < words.length; i++) {
                var test = cur ? cur + ' ' + words[i] : words[i];
                if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = words[i]; }
                else cur = test;
            }
            if (cur) lines.push(cur);
            return lines;
        }
        function introLayout() {
            var bw = Math.min(230, W * 0.5), bh = Math.max(42, Math.min(52, H * 0.11));
            return { play: { x: W / 2 - bw / 2, y: H - bh - Math.max(14, H * 0.06), w: bw, h: bh } };
        }
        function drawPlayButton(L, label) {
            var b = L.play;
            var g = ctx.createLinearGradient(b.x, 0, b.x + b.w, 0);
            g.addColorStop(0, '#ff3d71'); g.addColorStop(1, '#f9004d');
            ctx.fillStyle = g;
            api.roundRect(ctx, b.x, b.y, b.w, b.h, b.h / 2);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.font = '800 ' + Math.round(Math.min(16, b.h * 0.34)) + 'px Montserrat, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(label, b.x + b.w / 2, b.y + b.h / 2 + 5);
        }
        function drawIntro() {
            ctx.fillStyle = 'rgba(7,10,20,0.94)';
            ctx.fillRect(0, 0, W, H);
            var info = INFO[active.id] || {};
            var pad = Math.max(16, W * 0.06);
            var maxW = W - pad * 2;
            var small = W < 520;
            var y = Math.max(30, H * 0.11);
            ctx.textAlign = 'center';

            ctx.font = (small ? '26px' : '34px') + ' sans-serif';
            ctx.fillText(active.icon || '🎮', W / 2, y);
            y += small ? 30 : 38;

            ctx.fillStyle = api.colors.white;
            ctx.font = '800 ' + (small ? 20 : 26) + 'px Montserrat, sans-serif';
            ctx.fillText(active.name, W / 2, y);
            y += small ? 20 : 26;

            if (info.goal) {
                ctx.fillStyle = api.colors.accent2;
                ctx.font = '600 ' + (small ? 12 : 14) + 'px Poppins, Montserrat, sans-serif';
                wrapLines(info.goal, maxW).forEach(function (ln) {
                    ctx.fillText(ln, W / 2, y);
                    y += small ? 16 : 19;
                });
            }
            y += small ? 8 : 14;

            ctx.fillStyle = api.colors.muted;
            ctx.font = '700 ' + (small ? 9 : 11) + 'px Montserrat, sans-serif';
            ctx.fillText('HOW TO PLAY', W / 2, y);
            y += small ? 15 : 20;

            ctx.font = '500 ' + (small ? 11 : 13) + 'px Poppins, Montserrat, sans-serif';
            var tips = info.how || [];
            var blocks = [], widest = 0;
            tips.forEach(function (tip) {
                var lines = wrapLines(tip, maxW - 26);
                lines.forEach(function (ln) { widest = Math.max(widest, ctx.measureText(ln).width); });
                blocks.push(lines);
            });
            var lx = Math.max(pad, W / 2 - (widest + 18) / 2);
            ctx.textAlign = 'left';
            blocks.forEach(function (lines) {
                lines.forEach(function (ln, k) {
                    if (k === 0) {
                        ctx.fillStyle = api.colors.accent;
                        ctx.fillText('▸', lx, y);
                    }
                    ctx.fillStyle = '#c3c9d5';
                    ctx.fillText(ln, lx + 18, y);
                    y += small ? 15 : 18;
                });
                y += small ? 2 : 4;
            });

            ctx.textAlign = 'center';
            var best = parseInt(localStorage.getItem('arcade-best-' + active.id) || '0', 10);
            if (best > 0 && !active.noScore) {
                ctx.fillStyle = api.colors.gold;
                ctx.font = '700 ' + (small ? 11 : 13) + 'px Montserrat, sans-serif';
                ctx.fillText('Your best: ' + best, W / 2, Math.min(y + 6, introLayout().play.y - 12));
            }

            var L = introLayout();
            var pulse = 0.85 + 0.15 * Math.sin(performance.now() / 320);
            ctx.globalAlpha = pulse;
            drawPlayButton(L, '▶  PLAY');
            ctx.globalAlpha = 1;
            ctx.textAlign = 'left';
        }
        function drawPaused() {
            veil();
            var small = W < 520;
            ctx.textAlign = 'center';
            ctx.fillStyle = api.colors.accent;
            ctx.font = '800 ' + (small ? 30 : 40) + 'px Montserrat, sans-serif';
            ctx.fillText('PAUSED', W / 2, H * 0.38);
            ctx.fillStyle = api.colors.muted;
            ctx.font = '600 ' + (small ? 12 : 13) + 'px Poppins, Montserrat, sans-serif';
            ctx.fillText('Score so far: ' + score, W / 2, H * 0.38 + (small ? 24 : 30));
            ctx.fillStyle = api.colors.muted;
            ctx.font = '600 11px Montserrat, sans-serif';
            ctx.fillText('TAP THE BUTTON OR PRESS P / ESC', W / 2, H * 0.38 + (small ? 44 : 54));
            var L = introLayout();
            var pulse = 0.85 + 0.15 * Math.sin(performance.now() / 320);
            ctx.globalAlpha = pulse;
            drawPlayButton(L, '▶  RESUME');
            ctx.globalAlpha = 1;
            ctx.textAlign = 'left';
        }

        function drawOverlay() {
            ctx.fillStyle = 'rgba(7,10,20,0.78)';
            ctx.fillRect(0, 0, W, H);
            ctx.textAlign = 'center';
            ctx.fillStyle = overLabel === 'YOU WIN!' ? api.colors.green : api.colors.accent;
            // shrink long labels ("OUT OF MEMORY", "SERVER TIMEOUT") to fit narrow canvases
            ctx.font = '800 44px Montserrat, sans-serif';
            var lw = ctx.measureText(overLabel).width;
            if (lw > W - 44) {
                ctx.font = '800 ' + Math.max(20, Math.floor(44 * (W - 44) / lw)) + 'px Montserrat, sans-serif';
            }
            ctx.fillText(overLabel, W / 2, H / 2 - 40);
            ctx.fillStyle = api.colors.white;
            ctx.font = '700 26px Montserrat, sans-serif';
            ctx.fillText('Score: ' + score, W / 2, H / 2 + 4);
            var best = parseInt(localStorage.getItem('arcade-best-' + active.id) || '0', 10);
            ctx.fillStyle = api.colors.muted;
            ctx.font = '600 16px Montserrat, sans-serif';
            ctx.fillText('Best: ' + best, W / 2, H / 2 + 32);
            var pulse = 0.6 + 0.4 * Math.sin(performance.now() / 300);
            ctx.globalAlpha = pulse;
            ctx.fillStyle = api.colors.white;
            ctx.font = '700 15px Montserrat, sans-serif';
            ctx.fillText('CLICK / TAP TO PLAY AGAIN', W / 2, H / 2 + 72);
            ctx.globalAlpha = 1;
            ctx.textAlign = 'left';
        }

        function loop(t) {
            if (!running) return;
            var dt = Math.min(0.033, (t - last) / 1000 || 0.016);
            last = t;
            api.W = W; api.H = H;
            if (state === 'play' && tiltOn && usesSteer() && tiltLast) {
                if (!tiltZero) tiltZero = { beta: tiltLast.beta, gamma: tiltLast.gamma };
                var dg = tiltLast.gamma - tiltZero.gamma;
                var db = tiltLast.beta - tiltZero.beta;
                // remap axes to match how the screen is rotated
                var ori = (screen.orientation && typeof screen.orientation.angle === 'number')
                    ? screen.orientation.angle : (window.orientation || 0);
                var nx, ny;
                if (ori === 90) { nx = db / 20; ny = -dg / 20; }
                else if (ori === -90 || ori === 270) { nx = -db / 20; ny = dg / 20; }
                else if (ori === 180) { nx = -dg / 20; ny = -db / 20; }
                else { nx = dg / 20; ny = db / 20; }
                var ttx = W / 2 + clampN(nx, -1, 1) * (W / 2 - 12);
                var tty = H / 2 + clampN(ny, -1, 1) * (H / 2 - 12);
                var tk = Math.min(1, dt * 9);
                virt.x += (ttx - virt.x) * tk;
                virt.y += (tty - virt.y) * tk;
                api.pointer.x = virt.x; api.pointer.y = virt.y;
                if (active.pointerMove) active.pointerMove({ x: virt.x, y: virt.y }, api);
            }
            if (state === 'play' && !(active.blocksPlay && active.blocksPlay())) active.step(dt, api);
            stepParticles(dt);
            if (shakeT > 0) shakeT -= dt;

            ctx.clearRect(0, 0, W, H);
            ctx.save();
            if (shakeT > 0) {
                ctx.translate((Math.random() - 0.5) * shakePow, (Math.random() - 0.5) * shakePow);
            }
            ctx.fillStyle = 'rgba(255,255,255,0.06)';
            for (var gx = 24; gx < W; gx += 48)
                for (var gy = 24; gy < H; gy += 48)
                    ctx.fillRect(gx, gy, 2, 2);
            active.draw(ctx, api);
            drawParticles();
            ctx.restore();
            if (state === 'over') drawOverlay();
            else if (state === 'entry') drawEntry();
            else if (state === 'board') drawBoard();
            else if (active.blocksPlay && active.blocksPlay()) { /* module draws its own lobby */ }
            else if (state === 'intro') drawIntro();
            else if (state === 'paused') drawPaused();
            requestAnimationFrame(loop);
        }
        function start() {
            if (running) return;
            running = true;
            last = performance.now();
            requestAnimationFrame(loop);
        }
        if ('IntersectionObserver' in window) {
            new IntersectionObserver(function (entries) {
                visible = entries[0].isIntersecting;
                if (visible) start(); else running = false;
            }, { threshold: 0.05 }).observe(canvas);
        } else {
            visible = true;
            start();
        }

        /* ----- Fullscreen: native API where available, pseudo-fullscreen
                 (fixed overlay) on iOS Safari. Game restarts on toggle so
                 layout-dependent games rebuild for the new canvas size. ----- */
        var fsBtn = document.createElement('button');
        fsBtn.type = 'button';
        fsBtn.className = 'play-fs-btn';
        fsBtn.setAttribute('aria-label', 'Toggle fullscreen');
        fsBtn.textContent = '⛶ Fullscreen';
        // lives in the HUD bar, not on the canvas — games draw their own HUDs
        // along the top edge and a floating button would cover them
        if (hudEl) hudEl.insertBefore(fsBtn, hudEl.firstChild); else wrap.appendChild(fsBtn);

        function setFsUI(on) {
            wrap.classList.toggle('is-fs', on);
            document.documentElement.classList.toggle('arcade-fs-lock', on);
            fsBtn.textContent = on ? '✕ Exit' : '⛶ Fullscreen';
            resize();
            restartActive();
        }
        fsBtn.addEventListener('click', function () {
            if (!wrap.classList.contains('is-fs')) {
                if (wrap.requestFullscreen) {
                    var pr = wrap.requestFullscreen();
                    if (pr && pr.catch) pr.catch(function () { pseudoFs = true; setFsUI(true); });
                } else {
                    pseudoFs = true;
                    setFsUI(true);
                }
            } else if (document.fullscreenElement === wrap) {
                document.exitFullscreen();
            } else {
                pseudoFs = false;
                setFsUI(false);
            }
        });
        document.addEventListener('fullscreenchange', function () {
            if (!pseudoFs) setFsUI(document.fullscreenElement === wrap);
        });

        var pauseBtn = document.createElement('button');
        pauseBtn.type = 'button';
        pauseBtn.className = 'play-fs-btn play-pause-btn';
        pauseBtn.setAttribute('aria-label', 'Pause or resume the game');
        pauseBtn.textContent = '⏸ Pause';
        if (hudEl) hudEl.insertBefore(pauseBtn, fsBtn.nextSibling); else wrap.appendChild(pauseBtn);
        pauseBtn.addEventListener('click', function () {
            if (state === 'paused') setPaused(false);
            else if (state === 'intro') startPlay();
            else if (state === 'play') setPaused(true);
        });
        document.addEventListener('visibilitychange', function () {
            if (document.hidden && state === 'play') setPaused(true);
        });

        var lbBtn = document.createElement('button');
        lbBtn.type = 'button';
        lbBtn.className = 'play-fs-btn play-lb-btn';
        lbBtn.setAttribute('aria-label', 'Show worldwide top 10');
        lbBtn.textContent = '🏆 Top 10';
        if (LB_ENABLED) { if (hudEl) hudEl.insertBefore(lbBtn, fsBtn.nextSibling); else wrap.appendChild(lbBtn); }
        lbBtn.addEventListener('click', function () {
            if (!active || active.noScore || active.noBoard) return;
            if (state === 'board') { boardProceed(); return; }
            if (state === 'entry' || state === 'over') { openBoard('over'); return; }
            openBoard('play');
        });

        hireEl = document.createElement('div');
        hireEl.className = 'play-hire';
        hireEl.innerHTML = '<span>Enjoying the arcade? I build games for a living.</span> <a href="#contact">Let&rsquo;s build yours &rarr;</a>';
        wrap.appendChild(hireEl);
        hireEl.querySelector('a').addEventListener('click', function () {
            if (wrap.classList.contains('is-fs')) fsBtn.click(); // leave fullscreen so the page can scroll
            hideHire();
        });

        buildTabs();
        if (order.length) select(order[0]);

        // localhost-only test hook (never active in production)
        if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
            window.__arcade = {
                getState: function () { return state; },
                getBoard: function () { return { status: board.status, rows: board.rows, offline: lb.offline }; },
                forceOver: function (sc, label) { api.setScore(sc || 42); api.gameOver(sc || 42, label); },
                select: select,
                submit: submitEntry,
                layout: entryLayout,
                skip: function () { openBoard('over'); },
                api: api,
                setVisible: function (v) { visible = !!v; },
                tick: function (dt, w, h) {
                    if (w) { W = w; H = h; api.W = w; api.H = h; }
                    // mirror the real loop's gating so tests reflect production
                    if (state !== 'play') return;
                    if (active && active.blocksPlay && active.blocksPlay()) return;
                    if (active && active.step) active.step(dt || 0.016, api);
                },
                clickControl: function (i) {
                    var btns = controlsEl ? controlsEl.querySelectorAll('button') : [];
                    if (btns[i || 0]) btns[i || 0].click();
                }
            };
        }
    });
})();

/* ============================================================
   Game 1: Physics Sandbox (the original playground, as a module)
   ============================================================ */
(function () {
    'use strict';
    var bodies = [];
    var MAX = 80;
    var TYPES = ['ball', 'box', 'gem'];
    var gravModes = [{ name: 'Earth', g: 1900 }, { name: 'Moon', g: 320 }, { name: 'Zero-G', g: 0 }];
    var gravIdx = 0;
    var grabbed = null;
    var spawnCount = 0, flingDone = false, zeroDone = false, hoardDone = false;

    function makeBody(api, x, y, vx, vy, type) {
        var r = 14 + Math.random() * 18;
        var colors = [api.colors.accent, api.colors.accent2, api.colors.blue, api.colors.gold, api.colors.green, api.colors.white];
        return {
            x: x, y: y, vx: vx || 0, vy: vy || 0,
            r: r, m: r * r,
            type: type || TYPES[(Math.random() * TYPES.length) | 0],
            c: colors[(Math.random() * colors.length) | 0],
            a: Math.random() * Math.PI, va: (Math.random() - 0.5) * 3
        };
    }

    function spawn(api, x, y) {
        if (bodies.length >= MAX) bodies.shift();
        bodies.push(makeBody(api, x, y, api.rand(-80, 80), api.rand(-120, 0)));
        api.spawnParticles(x, y, api.colors.white, 4);
        spawnCount++;
        api.setScore(bodies.length);
        if (spawnCount === 1) api.toast('🏆 Hello, physics! <span class="xp">+10 XP</span>');
        if (spawnCount === 50 && !hoardDone) { hoardDone = true; api.toast('🏆 Object hoarder <span class="xp">+25 XP</span>'); }
    }

    window.ARCADE.register({
        id: 'sandbox',
        name: 'Physics Sandbox',
        noBoard: true,
        icon: '🧲',
        hint: 'Click to spawn · drag to throw',
        noScore: false,
        scoreLabel: 'Bodies',
        controls: [
            {
                label: '+10 Objects', primary: true,
                onClick: function (api) {
                    for (var i = 0; i < 10; i++) spawn(api, 40 + Math.random() * (api.W - 80), 30 + Math.random() * 60);
                }
            },
            {
                label: function () { return 'Gravity: ' + gravModes[gravIdx].name; },
                onClick: function (api) {
                    gravIdx = (gravIdx + 1) % gravModes.length;
                    if (gravModes[gravIdx].g === 0 && !zeroDone) { zeroDone = true; api.toast('🏆 Zero gravity unlocked <span class="xp">+15 XP</span>'); }
                }
            },
            { label: 'Clear', onClick: function (api) { bodies.length = 0; api.setScore(0); } }
        ],
        start: function (api) {
            bodies.length = 0;
            grabbed = null;
            gravIdx = 0;
            var cx = api.W / 2;
            for (var row = 0; row < 3; row++) {
                for (var col = 0; col <= row; col++) {
                    var bb = makeBody(api, cx + (col - row / 2) * 52, api.H - 26 - (2 - row) * 50, 0, 0, 'box');
                    bb.r = 22; bb.m = bb.r * bb.r; bb.va = 0; bb.a = 0;
                    bodies.push(bb);
                }
            }
            bodies.push(makeBody(api, cx - 180, api.H - 30, 0, 0, 'ball'));
            bodies.push(makeBody(api, cx + 190, api.H - 26, 0, 0, 'gem'));
            api.setScore(bodies.length);
        },
        pointerDown: function (p, api) {
            for (var i = bodies.length - 1; i >= 0; i--) {
                var b = bodies[i];
                var dx = b.x - p.x, dy = b.y - p.y;
                if (dx * dx + dy * dy < (b.r + 8) * (b.r + 8)) { grabbed = b; return; }
            }
            spawn(api, p.x, p.y);
        },
        pointerUp: function (p, api) {
            if (grabbed) {
                var speed = Math.sqrt(grabbed.vx * grabbed.vx + grabbed.vy * grabbed.vy);
                if (speed > 900 && !flingDone) { flingDone = true; api.toast('🏆 YEET! <span class="xp">+20 XP</span>'); }
            }
            grabbed = null;
        },
        step: function (dt, api) {
            var W = api.W, H = api.H;
            var g = gravModes[gravIdx].g;
            var i, j, b;
            for (i = 0; i < bodies.length; i++) {
                b = bodies[i];
                if (b === grabbed) {
                    b.vx = (api.pointer.x - b.x) * 18;
                    b.vy = (api.pointer.y - b.y) * 18;
                } else {
                    b.vy += g * dt;
                }
                b.x += b.vx * dt;
                b.y += b.vy * dt;
                b.a += b.va * dt * 2;
                if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx) * 0.7; b.va *= -0.8; }
                if (b.x > W - b.r) { b.x = W - b.r; b.vx = -Math.abs(b.vx) * 0.7; b.va *= -0.8; }
                if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy) * 0.7; }
                if (b.y > H - b.r) {
                    b.y = H - b.r;
                    b.vy = -Math.abs(b.vy) * 0.62;
                    b.vx *= 0.985;
                    if (Math.abs(b.vy) < 30) b.vy = 0;
                }
            }
            for (i = 0; i < bodies.length; i++) {
                for (j = i + 1; j < bodies.length; j++) {
                    var A = bodies[i], B = bodies[j];
                    var dx = B.x - A.x, dy = B.y - A.y;
                    var min = A.r + B.r;
                    var d2 = dx * dx + dy * dy;
                    if (d2 > min * min || d2 === 0) continue;
                    var d = Math.sqrt(d2);
                    var nx = dx / d, ny = dy / d;
                    var overlap = (min - d) / 2;
                    A.x -= nx * overlap; A.y -= ny * overlap;
                    B.x += nx * overlap; B.y += ny * overlap;
                    var vn = (B.vx - A.vx) * nx + (B.vy - A.vy) * ny;
                    if (vn < 0) {
                        var imp = -1.55 * vn / (1 / A.m + 1 / B.m);
                        A.vx -= imp * nx / A.m; A.vy -= imp * ny / A.m;
                        B.vx += imp * nx / B.m; B.vy += imp * ny / B.m;
                    }
                }
            }
        },
        draw: function (ctx, api) {
            for (var i = 0; i < bodies.length; i++) {
                var b = bodies[i];
                ctx.save();
                ctx.translate(b.x, b.y);
                ctx.rotate(b.a);
                ctx.fillStyle = b.c;
                ctx.strokeStyle = 'rgba(11,17,32,0.55)';
                ctx.lineWidth = 3;
                if (b.type === 'ball') {
                    ctx.beginPath(); ctx.arc(0, 0, b.r, 0, 6.2832); ctx.fill(); ctx.stroke();
                    ctx.fillStyle = 'rgba(255,255,255,0.35)';
                    ctx.beginPath(); ctx.arc(-b.r * 0.3, -b.r * 0.35, b.r * 0.28, 0, 6.2832); ctx.fill();
                } else if (b.type === 'box') {
                    var s = b.r * 1.7;
                    api.roundRect(ctx, -s / 2, -s / 2, s, s, 6); ctx.fill(); ctx.stroke();
                } else {
                    ctx.beginPath();
                    for (var k = 0; k < 6; k++) {
                        var ang = k * Math.PI / 3;
                        ctx[k ? 'lineTo' : 'moveTo'](Math.cos(ang) * b.r, Math.sin(ang) * b.r);
                    }
                    ctx.closePath();
                    ctx.fill(); ctx.stroke();
                }
                ctx.restore();
            }
        }
    });
})();

/* ============================================================
   Game 2: Stack Tower
   ============================================================ */
(function () { 'use strict';

  var BH = 32, SKX = 9, SKY = 6, PERFECT_PX = 4, GROW = 4;
  var blocks, slices, floats, current, cam, score, combo, startW;
  var dropping, dropVy, over, ending, overT, flashT, flashIdx, landT, tGlob;
  var toastPerfect, toastTen;
  var shadeCache = {};

  function shade(hex, f) {
    var key = hex + '|' + f;
    if (shadeCache[key]) return shadeCache[key];
    var r = parseInt(hex.slice(1, 3), 16),
        g = parseInt(hex.slice(3, 5), 16),
        b = parseInt(hex.slice(5, 7), 16);
    var t = f < 0 ? 0 : 255, p = Math.abs(f);
    r = Math.round(r + (t - r) * p);
    g = Math.round(g + (t - g) * p);
    b = Math.round(b + (t - b) * p);
    var c = 'rgb(' + r + ',' + g + ',' + b + ')';
    shadeCache[key] = c;
    return c;
  }

  function palHex(i, api) {
    var c = api.colors;
    return [c.accent, c.blue, c.accent2][i % 3];
  }

  function drawBlock(ctx, x, y, w, h, hex) {
    ctx.fillStyle = shade(hex, -0.38);
    ctx.beginPath();
    ctx.moveTo(x + w, y);
    ctx.lineTo(x + w + SKX, y - SKY);
    ctx.lineTo(x + w + SKX, y + h - SKY);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = shade(hex, 0.34);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + SKX, y - SKY);
    ctx.lineTo(x + w + SKX, y - SKY);
    ctx.lineTo(x + w, y);
    ctx.closePath();
    ctx.fill();
    var g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, shade(hex, 0.10));
    g.addColorStop(1, shade(hex, -0.22));
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, w, 2);
    ctx.globalAlpha = 1;
  }

  function topBlock() { return blocks[blocks.length - 1]; }

  function baseSpeed(api) { return Math.max(150, api.W * 0.22); }

  function speedNow(api) {
    var m = 1 + Math.floor(score / 3) * 0.12;
    if (m > 2.8) m = 2.8;
    return baseSpeed(api) * m;
  }

  function addFloat(txt, wx, wy, color, size) {
    floats.push({ txt: txt, wx: wx, wy: wy, t: 1, color: color, size: size || 22 });
    if (floats.length > 8) floats.shift();
  }

  function spawnCurrent(api) {
    var top = topBlock();
    var idx = top.i + 1;
    var w = top.w;
    var range = Math.max(8, api.W / 2 - w / 2 - 10);
    var side = (idx % 2 === 0) ? 1 : -1;
    current = { i: idx, cx: side * range, w: w, y: -(idx + 2) * BH, dir: -side };
    dropping = false;
  }

  function dropNow() {
    if (over || ending || dropping || !current) return;
    dropping = true;
    dropVy = 220;
  }

  function resolve(api) {
    var top = topBlock();
    var idx = current.i;
    var cx = current.cx, w = current.w;
    var L = cx - w / 2, R = cx + w / 2;
    var TL = top.cx - top.w / 2, TR = top.cx + top.w / 2;
    var oL = Math.max(L, TL), oR = Math.min(R, TR), ow = oR - oL;
    var hw = api.W / 2;

    if (ow <= 0) {
      var d = cx > top.cx ? 1 : -1;
      api.spawnParticles(hw + cx, current.y + cam + BH / 2, palHex(idx, api), 18);
      api.shake(8);
      slices.push({ cx: cx, wy: current.y, w: w, c: idx % 3, vy: -30, vx: d * (140 + api.rand(0, 100)), rot: 0, vr: d * api.rand(2.5, 6) });
      addFloat('MISSED!', cx, current.y - 12, api.colors.accent, 26);
      current = null;
      ending = true;
      overT = 0.75;
      return;
    }

    var nb;
    if (Math.abs(cx - top.cx) <= PERFECT_PX) {
      var nw = Math.min(startW, w + GROW);
      nb = { i: idx, cx: top.cx, w: nw, c: idx % 3 };
      combo++;
      flashT = 0.32;
      flashIdx = idx;
      var py = -(idx + 1) * BH + cam + BH / 2;
      api.spawnParticles(hw + top.cx - nw / 2, py, api.colors.gold, 10);
      api.spawnParticles(hw + top.cx + nw / 2, py, api.colors.gold, 10);
      addFloat(combo > 1 ? 'PERFECT x' + combo + '!' : 'PERFECT!', top.cx, -(idx + 1) * BH - 16, api.colors.gold, combo > 1 ? 25 : 22);
      if (combo >= 2) api.shake(4);
      if (!toastPerfect) {
        toastPerfect = true;
        api.toast('🏆 Bullseye! First perfect drop <span class="xp">+15 XP</span>');
      }
    } else {
      nb = { i: idx, cx: (oL + oR) / 2, w: ow, c: idx % 3 };
      combo = 0;
      var sw, scx, dir;
      if (L < TL) { sw = TL - L; scx = (L + TL) / 2; dir = -1; }
      else { sw = R - TR; scx = (TR + R) / 2; dir = 1; }
      slices.push({ cx: scx, wy: -(idx + 1) * BH, w: sw, c: idx % 3, vy: -60, vx: dir * (90 + api.rand(0, 90)), rot: 0, vr: dir * api.rand(2.5, 5.5) });
      api.spawnParticles(hw + (dir < 0 ? oL : oR), -(idx + 1) * BH + cam + BH / 2, palHex(idx, api), Math.round(Math.min(16, 5 + sw * 0.15)));
      api.shake(Math.min(6, 4 + sw * 0.02));
      if (ow < startW * 0.3) addFloat('CLOSE ONE!', nb.cx, -(idx + 1) * BH - 16, api.colors.white, 15);
    }

    blocks.push(nb);
    landT = 0.12;
    score++;
    api.setScore(score);
    if (score === 10 && !toastTen) {
      toastTen = true;
      api.toast('🏗️ High Rise: 10 layers <span class="xp">+25 XP</span>');
    }
    if (score > 0 && score % 25 === 0) addFloat(score + ' LAYERS!', nb.cx, -(idx + 1) * BH - 40, api.colors.gold, 28);
    current = null;
    spawnCurrent(api);
  }

  window.ARCADE.register({
    id: 'stack', name: 'Stack Tower', icon: '🏗️',
    hint: 'Click / tap to drop the block',

    start: function (api) {
      startW = Math.min(280, api.W * 0.5);
      blocks = [{ i: 0, cx: 0, w: startW, c: 0 }];
      slices = [];
      floats = [];
      score = 0;
      combo = 0;
      over = false;
      ending = false;
      overT = 0;
      dropping = false;
      dropVy = 0;
      flashT = 0;
      flashIdx = -1;
      landT = 0;
      tGlob = 0;
      toastPerfect = false;
      toastTen = false;
      cam = api.H - 40;
      current = null;
      api.setScore(0);
      spawnCurrent(api);
    },

    step: function (dt, api) {
      if (over) return;
      tGlob += dt;

      var desired = Math.max(api.H - 40, api.H * 0.55 + (topBlock().i + 1) * BH);
      cam += (desired - cam) * Math.min(1, dt * 5);

      if (flashT > 0) flashT -= dt;
      if (landT > 0) landT -= dt;

      var i;
      for (i = floats.length - 1; i >= 0; i--) {
        floats[i].t -= dt * 0.9;
        floats[i].wy -= 26 * dt;
        if (floats[i].t <= 0) floats.splice(i, 1);
      }

      for (i = slices.length - 1; i >= 0; i--) {
        var s = slices[i];
        s.vy += 1600 * dt;
        s.wy += s.vy * dt;
        s.cx += s.vx * dt;
        s.rot += s.vr * dt;
        if (s.wy + cam > api.H + 160) slices.splice(i, 1);
      }

      while (blocks.length > 6 && (-(blocks[0].i) * BH + cam) > api.H + 80) blocks.shift();

      if (ending) {
        overT -= dt;
        if (overT <= 0) {
          over = true;
          api.gameOver(score);
        }
        return;
      }

      if (current) {
        if (dropping) {
          current.y += dropVy * dt;
          dropVy += 4800 * dt;
          var ty = -(current.i + 1) * BH;
          if (current.y >= ty) {
            current.y = ty;
            resolve(api);
          }
        } else {
          var range = Math.max(8, api.W / 2 - current.w / 2 - 10);
          current.cx += current.dir * speedNow(api) * dt;
          if (current.cx > range) { current.cx = range; current.dir = -1; }
          else if (current.cx < -range) { current.cx = -range; current.dir = 1; }
        }
      }
    },

    draw: function (ctx, api) {
      var W = api.W, H = api.H, C = api.colors, hw = W / 2;
      var i, b, sx, sy;

      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      ctx.globalAlpha = 0.07;
      ctx.fillStyle = C.white;
      ctx.font = '900 96px Montserrat, sans-serif';
      ctx.fillText(String(score), hw, 84);
      ctx.globalAlpha = 1;

      if (combo >= 2) {
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = C.gold;
        ctx.font = '800 14px Montserrat, sans-serif';
        ctx.fillText('★ STREAK x' + combo, hw, 148);
        ctx.globalAlpha = 1;
      }

      for (i = 0; i < blocks.length; i++) {
        b = blocks[i];
        sy = -(b.i + 1) * BH + cam;
        if (sy > H + 60 || sy + BH < -40) continue;
        sx = hw + b.cx - b.w / 2;
        var isTop = (i === blocks.length - 1);
        if (isTop && landT > 0) {
          var sc = 1 - 0.3 * (landT / 0.12);
          ctx.save();
          ctx.translate(0, sy + BH);
          ctx.scale(1, sc);
          ctx.translate(0, -(sy + BH));
          drawBlock(ctx, sx, sy, b.w, BH, palHex(b.i, api));
          ctx.restore();
        } else {
          drawBlock(ctx, sx, sy, b.w, BH, palHex(b.i, api));
        }
        if (flashT > 0 && b.i === flashIdx) {
          ctx.globalAlpha = (flashT / 0.32) * 0.75;
          ctx.fillStyle = C.gold;
          api.roundRect(ctx, sx - 3, sy - 3, b.w + 6, BH + 6, 5);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }

      if (current && !dropping && !ending && !over) {
        var gy = -(current.i + 1) * BH + cam;
        ctx.globalAlpha = 0.09;
        ctx.fillStyle = C.white;
        ctx.fillRect(hw + current.cx - current.w / 2, gy, current.w, BH);
        ctx.globalAlpha = 1;
      }

      for (i = 0; i < slices.length; i++) {
        var sl = slices[i];
        var cxs = hw + sl.cx, cys = sl.wy + cam + BH / 2;
        ctx.save();
        ctx.translate(cxs, cys);
        ctx.rotate(sl.rot);
        drawBlock(ctx, -sl.w / 2, -BH / 2, sl.w, BH, palHex(sl.c, api));
        ctx.restore();
      }

      if (current) {
        sy = current.y + cam;
        sx = hw + current.cx - current.w / 2;
        drawBlock(ctx, sx, sy, current.w, BH, palHex(current.i, api));
        if (score === 0 && !dropping) {
          ctx.globalAlpha = 0.55 + 0.35 * Math.sin(tGlob * 5);
          ctx.fillStyle = C.white;
          ctx.font = '700 15px Montserrat, sans-serif';
          ctx.fillText('TAP TO DROP THE BLOCK', hw, sy - 36);
          ctx.globalAlpha = 1;
        }
      }

      for (i = 0; i < floats.length; i++) {
        var f = floats[i];
        var fa = Math.max(0, Math.min(1, f.t * 1.5));
        ctx.globalAlpha = fa * 0.5;
        ctx.fillStyle = C.ink;
        ctx.font = '800 ' + f.size + 'px Montserrat, sans-serif';
        ctx.fillText(f.txt, hw + f.wx + 2, f.wy + cam + 2);
        ctx.globalAlpha = fa;
        ctx.fillStyle = f.color;
        ctx.fillText(f.txt, hw + f.wx, f.wy + cam);
      }

      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.restore();
    },

    pointerDown: function (p, api) { dropNow(); },

    keyDown: function (key, api) {
      if (key === ' ' || key === 'Enter' || key === 'ArrowDown') dropNow();
    }
  });
})();

/* ============================================================
   Game 3: Lag Runner
   ============================================================ */
(function () { 'use strict';

  // ---- persistent (per page load) achievement flags so toasts don't spam on restart
  var seenDouble = false, seenK = false;

  // ---- run state (fully reset in start)
  var time, speed, ramp, score, lastScoreInt, milestone, dead;
  var py, vy, grounded, airT, jumps, sx, sy, rot, runPhase, blinkT;
  var obstacles, spawnDist, groundScroll;
  var far, near, streaks, floaters;
  var fps, fpsT;

  function playerX(api) { return Math.max(58, api.W * 0.12); }
  function groundYOf(api) { return api.H - 40; }

  function mkBuilding(W, groundY, nearLayer, api) {
    return {
      x: api.rand(0, W + 260),
      w: nearLayer ? api.rand(40, 110) : api.rand(28, 90),
      h: nearLayer ? api.rand(30, 115) : api.rand(55, 175)
    };
  }

  function spawnObstacle(api) {
    var W = api.W, r = Math.random(), type;
    if (time < 6) type = 'spike';
    else if (time < 15) type = (r < 0.62) ? 'spike' : 'spike2';
    else {
      if (r < 0.46) type = 'spike';
      else if (r < 0.74) type = 'spike2';
      else type = 'block';
    }
    var o = { type: type, x: W + 60 };
    if (type === 'spike') { o.w = 30; o.h = 36; }
    else if (type === 'spike2') { o.w = 62; o.h = 36; }
    else { o.w = 46; o.h = 118; }
    obstacles.push(o);
    spawnDist = api.rand(340, 640) + speed * 0.3 + (type === 'block' ? 150 : 0);
  }

  function doJump(api) {
    if (dead) return;
    var px = playerX(api);
    if (grounded || (jumps === 0 && airT < 0.12)) {
      vy = -700; jumps = 1; grounded = false;
      sx = 0.68; sy = 1.34;
      api.spawnParticles(px, groundYOf(api) - 4, api.colors.muted, 8);
    } else if (jumps < 2) {
      vy = -670; jumps = 2;
      sx = 0.68; sy = 1.34;
      api.spawnParticles(px, py + 16, api.colors.blue, 10);
      floaters.push({ x: px, y: py - 36, txt: 'DOUBLE!', c: api.colors.blue, life: 0.8, max: 0.8 });
      if (!seenDouble) {
        seenDouble = true;
        api.toast('🏆 Frame-perfect double jump <span class="xp">+10 XP</span>');
      }
    }
  }

  function die(api) {
    if (dead) return;
    dead = true;
    var px = playerX(api);
    api.spawnParticles(px, py, api.colors.accent, 26);
    api.spawnParticles(px, py, api.colors.gold, 10);
    api.shake(9);
    api.gameOver(Math.floor(score), 'CRASHED');
  }

  window.ARCADE.register({
    id: 'runner', name: 'Lag Runner', icon: '⚡',
    hint: 'Click / tap / Space to jump — double jump allowed',

    start: function (api) {
      var W = api.W, groundY = groundYOf(api), i;
      time = 0; speed = 250 + W * 0.07; ramp = 1;
      score = 0; lastScoreInt = 0; milestone = 500; dead = false;
      py = groundY - 21; vy = 0; grounded = true; airT = 0; jumps = 0;
      sx = 1; sy = 1; rot = 0; runPhase = 0; blinkT = api.rand(1.5, 3.5);
      obstacles = []; spawnDist = W * 0.6 + 320; groundScroll = 0;
      far = []; near = []; streaks = []; floaters = [];
      fps = 60; fpsT = 0;
      for (i = 0; i < 9; i++) far.push(mkBuilding(W, groundY, false, api));
      for (i = 0; i < 6; i++) near.push(mkBuilding(W, groundY, true, api));
      for (i = 0; i < 6; i++) streaks.push({ x: api.rand(0, W), y: api.rand(40, groundY - 60), len: api.rand(40, 110) });
      api.setScore(0);
    },

    step: function (dt, api) {
      if (dead) return;
      var W = api.W, H = api.H, groundY = H - 40;
      var px = playerX(api), i, o, b;

      time += dt;
      var base = 250 + W * 0.07;
      ramp = Math.min(2.5, 1 + time * 0.02);
      speed = base * ramp;

      // score = distance frames
      score += dt * 10 * (speed / 300);
      var si = Math.floor(score);
      if (si !== lastScoreInt) { lastScoreInt = si; api.setScore(si); }
      if (si >= milestone) {
        floaters.push({ x: px + 14, y: py - 44, txt: milestone + ' FRAMES!', c: api.colors.gold, life: 1, max: 1 });
        api.spawnParticles(px, py - 10, api.colors.gold, 12);
        if (milestone === 1000 && !seenK) {
          seenK = true;
          api.toast('🏆 1,000 frames without a drop <span class="xp">+15 XP</span>');
        }
        milestone += 500;
      }

      // physics
      vy += 2600 * dt;
      py += vy * dt;
      if (py > groundY - 21) {
        py = groundY - 21;
        if (!grounded) { // landing
          jumps = 0; sx = 1.45; sy = 0.6;
          api.spawnParticles(px, groundY - 4, api.colors.muted, 9);
          if (vy > 1100) api.shake(4);
        }
        grounded = true; vy = 0; airT = 0;
      } else { grounded = false; airT += dt; }

      if (!grounded) rot = Math.max(-0.3, Math.min(0.45, vy / 1800));
      else rot += (Math.sin(runPhase * 2) * 0.03 - rot) * Math.min(1, dt * 14);
      var k = Math.min(1, dt * 9);
      sx += (1 - sx) * k; sy += (1 - sy) * k;
      runPhase += dt * (speed / 34);
      blinkT -= dt;
      if (blinkT < -0.1) blinkT = api.rand(1.6, 3.6);

      // obstacles
      spawnDist -= speed * dt;
      if (spawnDist <= 0) spawnObstacle(api);
      var pl = px - 14, pr = px + 14, pt = py - 15, pb = py + 18;
      for (i = obstacles.length - 1; i >= 0; i--) {
        o = obstacles[i];
        o.x -= speed * dt;
        if (o.x + o.w < -40) { obstacles.splice(i, 1); continue; }
        var ol, or_, ot, ob;
        if (o.type === 'block') { ol = o.x + 5; or_ = o.x + o.w - 5; ot = groundY - o.h + 6; ob = groundY; }
        else { ol = o.x + 6; or_ = o.x + o.w - 6; ot = groundY - o.h + 12; ob = groundY; }
        if (pr > ol && pl < or_ && pb > ot && pt < ob) { die(api); return; }
      }

      groundScroll = (groundScroll - speed * dt) % 46;

      // parallax
      for (i = 0; i < far.length; i++) {
        b = far[i]; b.x -= speed * 0.18 * dt;
        if (b.x + b.w < -10) { b.x = W + api.rand(10, 140); b.w = api.rand(28, 90); b.h = api.rand(55, 175); }
      }
      for (i = 0; i < near.length; i++) {
        b = near[i]; b.x -= speed * 0.42 * dt;
        if (b.x + b.w < -10) { b.x = W + api.rand(10, 140); b.w = api.rand(40, 110); b.h = api.rand(30, 115); }
      }
      // speed streaks
      if (ramp > 1.35) {
        for (i = 0; i < streaks.length; i++) {
          var s = streaks[i]; s.x -= speed * 1.6 * dt;
          if (s.x + s.len < 0) { s.x = W + api.rand(0, 160); s.y = api.rand(40, groundY - 60); s.len = api.rand(40, 110); }
        }
      }

      // floating text
      for (i = floaters.length - 1; i >= 0; i--) {
        var f = floaters[i]; f.life -= dt; f.y -= 34 * dt;
        if (f.life <= 0) floaters.splice(i, 1);
      }

      // fake fps counter
      fpsT -= dt;
      if (fpsT <= 0) { fpsT = 0.13; fps = Math.floor(60 * ramp + (ramp - 1) * 150 + api.rand(-4, 4)); }
    },

    draw: function (ctx, api) {
      var W = api.W, H = api.H, groundY = H - 40, C = api.colors;
      var px = playerX(api), i, o, b;

      ctx.save(); // snapshot ctx state so font/align/alpha/fill changes never leak to the core

      // ---- parallax city
      ctx.fillStyle = 'rgba(120,150,220,0.05)';
      for (i = 0; i < far.length; i++) { b = far[i]; ctx.fillRect(b.x, groundY - b.h, b.w, b.h); }
      ctx.fillStyle = 'rgba(120,150,220,0.09)';
      for (i = 0; i < near.length; i++) { b = near[i]; ctx.fillRect(b.x, groundY - b.h, b.w, b.h); }

      // ---- speed streaks
      if (ramp > 1.35) {
        ctx.fillStyle = 'rgba(232,236,243,' + Math.min(0.14, (ramp - 1.35) * 0.14).toFixed(3) + ')';
        for (i = 0; i < streaks.length; i++) { var st = streaks[i]; ctx.fillRect(st.x, st.y, st.len, 2); }
      }

      // ---- ground
      ctx.fillStyle = 'rgba(232,236,243,0.35)';
      ctx.fillRect(0, groundY, W, 2);
      ctx.fillStyle = 'rgba(138,147,165,0.28)';
      for (var gx = groundScroll; gx < W; gx += 46) ctx.fillRect(gx, groundY + 10, 20, 3);

      // ---- obstacles
      for (i = 0; i < obstacles.length; i++) {
        o = obstacles[i];
        if (o.type === 'block') {
          // memory leak block
          ctx.fillStyle = C.blue;
          api.roundRect(ctx, o.x, groundY - o.h, o.w, o.h, 7);
          ctx.fill();
          ctx.fillStyle = 'rgba(11,17,32,0.28)';
          api.roundRect(ctx, o.x + 5, groundY - o.h + 24, o.w - 10, o.h - 30, 4);
          ctx.fill();
          // memory cells, one blinking
          var cy, cxx, ci = 0;
          for (cy = 0; cy < 4; cy++) for (cxx = 0; cxx < 2; cxx++) {
            var blink = (ci === 3) && (Math.sin(time * 9) > 0);
            ctx.fillStyle = blink ? C.gold : 'rgba(232,236,243,0.25)';
            ctx.fillRect(o.x + 9 + cxx * 15, groundY - o.h + 30 + cy * 20, 10, 10);
            ci++;
          }
          ctx.font = '14px sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText('💾', o.x + o.w / 2, groundY - o.h + 12);
        } else {
          // lag spikes
          var n = (o.type === 'spike2') ? 2 : 1, j;
          for (j = 0; j < n; j++) {
            var bx = o.x + j * 32;
            ctx.fillStyle = 'rgba(249,0,77,0.25)';
            ctx.beginPath();
            ctx.moveTo(bx - 3, groundY);
            ctx.lineTo(bx + 15, groundY - o.h - 4);
            ctx.lineTo(bx + 33, groundY);
            ctx.closePath(); ctx.fill();
            ctx.fillStyle = C.accent2;
            ctx.beginPath();
            ctx.moveTo(bx, groundY);
            ctx.lineTo(bx + 15, groundY - o.h);
            ctx.lineTo(bx + 30, groundY);
            ctx.closePath(); ctx.fill();
            ctx.fillStyle = 'rgba(255,255,255,0.7)';
            ctx.beginPath();
            ctx.arc(bx + 15, groundY - o.h + 5, 1.6, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      // ---- player cube
      var bob = grounded ? -Math.abs(Math.sin(runPhase)) * 2.5 : 0;
      ctx.save();
      ctx.translate(px, py + bob);
      ctx.rotate(rot);
      ctx.scale(sx, sy);
      ctx.fillStyle = C.accent;
      api.roundRect(ctx, -21, -21, 42, 42, 10);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.22)'; // top shine
      api.roundRect(ctx, -15, -17, 30, 8, 4);
      ctx.fill();
      // eyes (looking forward, up when rising)
      var look = grounded ? 0 : Math.max(-2.5, Math.min(2.5, vy / 350));
      if (blinkT < 0.09 && blinkT > 0) {
        ctx.strokeStyle = C.ink; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(1, -5); ctx.lineTo(9, -5);
        ctx.moveTo(11, -5); ctx.lineTo(19, -5); ctx.stroke();
      } else {
        ctx.fillStyle = C.white;
        ctx.beginPath(); ctx.arc(5, -6, 5, 0, Math.PI * 2);
        ctx.arc(15, -6, 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = C.ink;
        ctx.beginPath(); ctx.arc(6.5, -6 + look, 2.4, 0, Math.PI * 2);
        ctx.arc(16.5, -6 + look, 2.4, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();

      // ---- floating text
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (i = 0; i < floaters.length; i++) {
        var f = floaters[i];
        ctx.globalAlpha = Math.max(0, f.life / f.max);
        ctx.font = '800 18px Montserrat, sans-serif';
        ctx.fillStyle = f.c;
        ctx.fillText(f.txt, f.x, f.y);
      }
      ctx.globalAlpha = 1;

      // ---- fake FPS counter
      ctx.textAlign = 'right'; ctx.textBaseline = 'top';
      ctx.font = '700 18px Montserrat, sans-serif';
      ctx.fillStyle = C.green;
      ctx.fillText(fps + ' FPS', W - 16, 14);
      ctx.font = '600 11px Montserrat, sans-serif';
      ctx.fillStyle = C.muted;
      ctx.fillText('x' + ramp.toFixed(1) + ' SPEED · NO LAG DETECTED', W - 16, 36);

      ctx.restore(); // restore ctx state (font, textAlign, textBaseline, globalAlpha, fillStyle)
    },

    pointerDown: function (p, api) { doJump(api); },

    keyDown: function (key, api) {
      if (key === ' ' || key === 'ArrowUp') doJump(api);
    }
  });
})();

/* ============================================================
   Game 4: Bug Hunter
   ============================================================ */
(function () { 'use strict';

  // ---------------- state ----------------
  var t, score, integrity;
  var bugs, floaters, splats;
  var spawnTimer, goldenTimer;
  var combo, comboTimer;
  var toastedFirst, toastedGold;
  var dying, dieT, overCalled, biteFlash;

  function resetState(api) {
    t = 0;
    score = 0;
    integrity = 100;
    bugs = [];
    floaters = [];
    splats = [];
    spawnTimer = 0.7;
    goldenTimer = api.rand(7, 11);
    combo = 0;
    comboTimer = 0;
    toastedFirst = false;
    toastedGold = false;
    dying = false;
    dieT = 0;
    overCalled = false;
    biteFlash = 0;
    api.setScore(0);
  }

  // ---------------- helpers ----------------
  function coreBox(api) {
    var cw = Math.min(160, api.W * 0.42);
    var ch = Math.min(70, cw * 0.46);
    return { x: api.W / 2, y: api.H / 2 + 6, w: cw, h: ch };
  }

  function spawnBug(api) {
    if (bugs.length >= 40) return;
    var side = Math.floor(api.rand(0, 4));
    var x, y;
    if (side === 0) { x = api.rand(20, api.W - 20); y = -26; }
    else if (side === 1) { x = api.rand(20, api.W - 20); y = api.H + 26; }
    else if (side === 2) { x = -26; y = api.rand(20, api.H - 20); }
    else { x = api.W + 26; y = api.rand(20, api.H - 20); }
    bugs.push({
      golden: false,
      x: x, y: y,
      size: api.rand(9, 13),
      speed: api.rand(34, 55) + Math.min(70, t * 1.15),
      phase: api.rand(0, 6.28),
      dir: 0
    });
  }

  function spawnGolden(api) {
    if (bugs.length >= 40) return;
    var fromLeft = api.rand(0, 1) < 0.5;
    var y = api.rand(60, api.H - 60);
    bugs.push({
      golden: true,
      x: fromLeft ? -34 : api.W + 34,
      y: y, baseY: y,
      vx: (fromLeft ? 1 : -1) * (240 + Math.min(160, t * 3)),
      size: 11,
      phase: api.rand(0, 6.28),
      dir: fromLeft ? 0 : Math.PI
    });
  }

  function addFloater(x, y, text, color, size) {
    floaters.push({ x: x, y: y, text: text, color: color, size: size || 18, t: 0, life: 0.9 });
    if (floaters.length > 20) floaters.shift();
  }

  function squash(idx, api) {
    var b = bugs[idx];
    bugs.splice(idx, 1);
    api.spawnParticles(b.x, b.y, b.golden ? api.colors.gold : api.colors.green, b.golden ? 26 : 16);
    splats.push({ x: b.x, y: b.y, r: b.size * 1.7, t: 0, life: 1.6, seed: Math.floor(api.rand(0, 100)), gold: b.golden });
    if (splats.length > 22) splats.shift();

    if (comboTimer > 0) combo++; else combo = 1;
    comboTimer = 1.15;

    var pts = (b.golden ? 5 : 1) + (combo > 1 ? combo - 1 : 0);
    score += pts;
    api.setScore(score);

    var col = b.golden ? api.colors.gold : (combo > 1 ? api.colors.gold : api.colors.green);
    addFloater(b.x, b.y - 14, '+' + pts + (combo > 1 ? '  x' + combo : ''), col, combo > 1 ? 20 : 17);
    if (combo >= 5) api.shake(4);

    if (!toastedFirst) {
      toastedFirst = true;
      api.toast('🏆 First bug squashed <span class="xp">+15 XP</span>');
    } else if (b.golden && !toastedGold) {
      toastedGold = true;
      api.toast('🏆 Golden bug bagged <span class="xp">+25 XP</span>');
    }
  }

  function trySquash(px, py, api, fromMove) {
    if (dying) return;
    var best = -1, bestD = 1e9;
    for (var i = bugs.length - 1; i >= 0; i--) {
      var b = bugs[i];
      var dx = b.x - px, dy = b.y - py;
      var r = b.size + (fromMove ? 10 : 18);
      var d2 = dx * dx + dy * dy;
      if (d2 < r * r && d2 < bestD) { bestD = d2; best = i; }
    }
    if (best >= 0) squash(best, api);
    else if (!fromMove) combo = 0; // whiffed — combo breaks
  }

  function bite(idx, api) {
    var b = bugs[idx];
    bugs.splice(idx, 1);
    api.spawnParticles(b.x, b.y, api.colors.accent, 18);
    api.shake(5);
    biteFlash = 0.35;
    integrity = Math.max(0, integrity - 15);
    var c = coreBox(api);
    addFloater(c.x, c.y - c.h / 2 - 34, '-15%', api.colors.accent, 20);
    if (integrity <= 0 && !dying) {
      dying = true;
      dieT = 0;
      bugs.length = 0;
      api.shake(10);
      api.spawnParticles(c.x, c.y, api.colors.accent, 30);
      api.spawnParticles(c.x, c.y, api.colors.gold, 20);
    }
  }

  // ---------------- drawing ----------------
  function drawBug(ctx, b, api) {
    ctx.save();
    ctx.translate(b.x, b.y);
    var wig = Math.sin(b.phase * 2) * 0.12;
    ctx.rotate(b.dir + wig);
    var s = b.size;

    // legs: 3 pairs of animated lines
    ctx.strokeStyle = b.golden ? 'rgba(217,154,0,0.95)' : '#3a4763';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (var i = -1; i <= 1; i++) {
      var lx = i * s * 0.55;
      var sw = Math.sin(b.phase * 2 + i * 1.9) * 3.5;
      ctx.moveTo(lx, -s * 0.55);
      ctx.lineTo(lx + sw - 2, -s * 0.55 - 5.5);
      ctx.moveTo(lx, s * 0.55);
      ctx.lineTo(lx + sw - 2, s * 0.55 + 5.5);
    }
    ctx.stroke();

    // antennae
    ctx.beginPath();
    ctx.moveTo(s * 1.35, -s * 0.2); ctx.lineTo(s * 1.85, -s * 0.5);
    ctx.moveTo(s * 1.35, s * 0.2); ctx.lineTo(s * 1.85, s * 0.5);
    ctx.stroke();

    // body: dark oval (golden glows)
    if (b.golden) { ctx.shadowColor = api.colors.gold; ctx.shadowBlur = 14; }
    ctx.fillStyle = b.golden ? api.colors.gold : '#2b3852';
    ctx.beginPath();
    ctx.ellipse(0, 0, s * 1.25, s * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // wing split line
    ctx.strokeStyle = b.golden ? 'rgba(120,80,0,0.5)' : 'rgba(11,17,32,0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-s * 1.15, 0); ctx.lineTo(s * 0.7, 0);
    ctx.stroke();

    // sheen
    ctx.fillStyle = 'rgba(232,236,243,' + (b.golden ? '0.35' : '0.10') + ')';
    ctx.beginPath();
    ctx.ellipse(-s * 0.25, -s * 0.3, s * 0.5, s * 0.2, -0.25, 0, Math.PI * 2);
    ctx.fill();

    // head
    ctx.fillStyle = b.golden ? '#c98e00' : '#1e2940';
    ctx.beginPath();
    ctx.ellipse(s * 1.05, 0, s * 0.55, s * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // red eyes
    ctx.fillStyle = '#ff4d4d';
    ctx.beginPath();
    ctx.arc(s * 1.22, -s * 0.22, s * 0.15 + 0.8, 0, 6.29);
    ctx.arc(s * 1.22, s * 0.22, s * 0.15 + 0.8, 0, 6.29);
    ctx.fill();

    ctx.restore();
  }

  function drawCore(ctx, api) {
    var c = coreBox(api);
    var low = integrity <= 30;
    var rate = low ? 7 : 3;
    var sc = 1 + 0.035 * Math.sin(t * rate);
    var glow = integrity > 60 ? api.colors.blue : (integrity > 30 ? api.colors.gold : api.colors.accent);

    ctx.save();
    ctx.translate(c.x, c.y);
    if (dying) {
      var k = Math.max(0, 1 - dieT);
      ctx.translate(Math.sin(dieT * 60) * 3 * k, Math.cos(dieT * 53) * 2.5 * k);
      ctx.globalAlpha = Math.max(0.35, 1 - dieT * 0.6);
    }
    ctx.scale(sc, sc);

    ctx.shadowColor = glow;
    ctx.shadowBlur = 20 + 8 * Math.sin(t * rate);
    var g = ctx.createLinearGradient(0, -c.h / 2, 0, c.h / 2);
    g.addColorStop(0, '#1c2740');
    g.addColorStop(1, '#101a30');
    ctx.fillStyle = g;
    api.roundRect(ctx, -c.w / 2, -c.h / 2, c.w, c.h, 14);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = glow;
    ctx.lineWidth = 1.5;
    api.roundRect(ctx, -c.w / 2, -c.h / 2, c.w, c.h, 14);
    ctx.stroke();

    // label
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = api.colors.white;
    ctx.font = '700 ' + Math.round(c.w * 0.105) + 'px Montserrat, sans-serif';
    ctx.fillText('⚙️ build.exe', 0, -c.h * 0.12);
    // compiling dots
    ctx.fillStyle = api.colors.muted;
    ctx.font = '600 ' + Math.round(c.w * 0.065) + 'px Montserrat, sans-serif';
    var dots = '';
    var n = Math.floor(t * 2.5) % 4;
    for (var i = 0; i < n; i++) dots += '.';
    ctx.textAlign = 'center';
    ctx.fillText(dying ? 'FATAL ERROR' : 'compiling' + dots, 0, c.h * 0.24);

    // cracks
    if (dying) {
      ctx.strokeStyle = '#0b1120';
      ctx.lineWidth = 3;
      ctx.lineJoin = 'miter';
      ctx.beginPath();
      ctx.moveTo(-c.w * 0.12, -c.h / 2);
      ctx.lineTo(-c.w * 0.02, -c.h * 0.1);
      ctx.lineTo(-c.w * 0.18, c.h * 0.15);
      ctx.lineTo(-c.w * 0.08, c.h / 2);
      ctx.moveTo(c.w * 0.28, -c.h / 2);
      ctx.lineTo(c.w * 0.16, -c.h * 0.05);
      ctx.lineTo(c.w * 0.3, c.h * 0.2);
      ctx.stroke();
    }
    ctx.restore();

    // integrity bar above core
    var bw = c.w, bh = 8;
    var bx = c.x - bw / 2, by = c.y - c.h / 2 - 22;
    ctx.fillStyle = 'rgba(232,236,243,0.12)';
    api.roundRect(ctx, bx, by, bw, bh, 4);
    ctx.fill();
    if (integrity > 0) {
      ctx.fillStyle = glow;
      api.roundRect(ctx, bx, by, Math.max(6, bw * integrity / 100), bh, 4);
      ctx.fill();
    }
    ctx.font = '600 10px Montserrat, sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = api.colors.muted;
    ctx.fillText('INTEGRITY', bx, by - 4);
    ctx.textAlign = 'right';
    ctx.fillStyle = glow;
    ctx.fillText(Math.round(integrity) + '%', bx + bw, by - 4);
    ctx.textAlign = 'left';
  }

  // ---------------- module ----------------
  window.ARCADE.register({
    id: 'bugs', name: 'Bug Hunter', icon: '🐛',
    hint: 'Click the bugs before they reach the build!',

    start: function (api) {
      resetState(api);
    },

    step: function (dt, api) {
      var i, b;

      // shared fades
      biteFlash = Math.max(0, biteFlash - dt);
      for (i = floaters.length - 1; i >= 0; i--) {
        floaters[i].t += dt;
        if (floaters[i].t >= floaters[i].life) floaters.splice(i, 1);
      }
      for (i = splats.length - 1; i >= 0; i--) {
        splats[i].t += dt;
        if (splats[i].t >= splats[i].life) splats.splice(i, 1);
      }

      if (dying) {
        dieT += dt;
        if (dieT > 0.85 && !overCalled) {
          overCalled = true;
          api.gameOver(score);
        }
        return;
      }

      t += dt;
      comboTimer -= dt;
      if (comboTimer <= 0) combo = 0;

      // spawning: interval shrinks, waves grow
      spawnTimer -= dt;
      if (spawnTimer <= 0) {
        spawnTimer = Math.max(0.45, 1.2 - t * 0.014);
        var count = Math.min(4, 1 + Math.floor(t / 22));
        for (i = 0; i < count; i++) spawnBug(api);
      }
      goldenTimer -= dt;
      if (goldenTimer <= 0) {
        goldenTimer = api.rand(8, 14);
        spawnGolden(api);
      }

      var c = coreBox(api);
      for (i = bugs.length - 1; i >= 0; i--) {
        b = bugs[i];
        if (b.golden) {
          b.x += b.vx * dt;
          b.y = b.baseY + Math.sin(t * 7 + b.phase) * 8;
          b.phase += dt * 22;
          if (b.x < -50 || b.x > api.W + 50) bugs.splice(i, 1);
        } else {
          var ang = Math.atan2(c.y - b.y, c.x - b.x);
          b.dir = ang;
          b.phase += dt * (6 + b.speed * 0.06);
          var sway = Math.sin(b.phase * 1.7) * 18;
          b.x += Math.cos(ang) * b.speed * dt + Math.cos(ang + Math.PI / 2) * sway * dt;
          b.y += Math.sin(ang) * b.speed * dt + Math.sin(ang + Math.PI / 2) * sway * dt;
          var nx = (b.x - c.x) / (c.w * 0.55);
          var ny = (b.y - c.y) / (c.h * 0.78);
          if (nx * nx + ny * ny < 1) {
            bite(i, api);
            if (dying) break; // bite() emptied bugs[]; stale indices would crash
          }
        }
      }
    },

    draw: function (ctx, api) {
      var i;
      ctx.save(); // restore at end so no ctx state (font/align/alpha/shadow) leaks to core

      // splats (under everything)
      for (i = 0; i < splats.length; i++) {
        var s = splats[i];
        var a = 0.5 * (1 - s.t / s.life);
        ctx.fillStyle = s.gold ? 'rgba(255,180,0,' + a + ')' : 'rgba(43,214,123,' + a + ')';
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, 6.29);
        ctx.arc(s.x + ((s.seed % 7) - 3) * 2.2, s.y + ((s.seed % 5) - 2) * 2.5, s.r * 0.45, 0, 6.29);
        ctx.arc(s.x - ((s.seed % 4) - 1.5) * 3, s.y + ((s.seed % 6) - 2.5) * 2, s.r * 0.32, 0, 6.29);
        ctx.fill();
      }

      drawCore(ctx, api);

      for (i = 0; i < bugs.length; i++) drawBug(ctx, bugs[i], api);

      // floating text
      ctx.textAlign = 'center';
      for (i = 0; i < floaters.length; i++) {
        var f = floaters[i];
        var fa = 1 - f.t / f.life;
        ctx.globalAlpha = fa;
        ctx.font = '800 ' + f.size + 'px Montserrat, sans-serif';
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, f.x, f.y - f.t * 44);
      }
      ctx.globalAlpha = 1;

      // combo HUD
      if (combo >= 2 && comboTimer > 0 && !dying) {
        var pulse = 1 + 0.1 * Math.sin(t * 14);
        ctx.font = '800 ' + Math.round(16 * pulse) + 'px Montserrat, sans-serif';
        ctx.fillStyle = api.colors.gold;
        ctx.fillText('COMBO x' + combo, api.W / 2, 30);
      }

      // bite flash
      if (biteFlash > 0) {
        ctx.fillStyle = 'rgba(249,0,77,' + (biteFlash * 0.5).toFixed(3) + ')';
        ctx.fillRect(0, 0, api.W, api.H);
      }

      ctx.restore();
    },

    pointerDown: function (p, api) {
      trySquash(p.x, p.y, api, false);
    },

    pointerMove: function (p, api) {
      if (p.down) trySquash(p.x, p.y, api, true);
    }
  });
})();

/* ============================================================
   Game 5: Asteroid Dodge
   ============================================================ */
(function () { 'use strict';

  var SHIP_R = 11;
  var AST_COLS = ['#5d6f8c', '#4a5a73', '#6e8099', '#54657f'];

  var ship, tilt, asteroids, floats, stars, pickup;
  var time, spawnT, pickupT, shield, inv, dead;
  var bonus, lastScore, hasInput;
  var firstGraze = false, firstShield = false; // persist across restarts

  function spawnAst(api) {
    var edge = Math.floor(api.rand(0, 4));
    var m = 60, x, y;
    if (edge === 0) { x = api.rand(-m, api.W + m); y = -m; }
    else if (edge === 1) { x = api.rand(-m, api.W + m); y = api.H + m; }
    else if (edge === 2) { x = -m; y = api.rand(-m, api.H + m); }
    else { x = api.W + m; y = api.rand(-m, api.H + m); }
    var tx = ship.x + api.rand(-90, 90);
    var ty = ship.y + api.rand(-90, 90);
    var d = Math.atan2(ty - y, tx - x);
    var sp = api.rand(80, 140) + Math.min(270, time * 3.5);
    var r = api.rand(12, 30 + Math.min(14, time * 0.35));
    var verts = [], n = 7 + Math.floor(api.rand(0, 4)), j;
    for (j = 0; j < n; j++) verts.push(api.rand(0.72, 1.15));
    asteroids.push({
      x: x, y: y, vx: Math.cos(d) * sp, vy: Math.sin(d) * sp,
      r: r, rot: api.rand(0, 6.283), rs: api.rand(-2.2, 2.2),
      verts: verts, grazed: false,
      col: AST_COLS[Math.floor(api.rand(0, AST_COLS.length))]
    });
  }

  function spawnPickup(api) {
    var fromLeft = api.rand(0, 1) < 0.5;
    pickup = {
      x: fromLeft ? -24 : api.W + 24,
      baseY: api.rand(api.H * 0.18, api.H * 0.82),
      vx: (fromLeft ? 1 : -1) * api.rand(55, 80),
      t: 0
    };
  }

  function addFloat(x, y, txt, col) {
    floats.push({ x: x, y: y, t: 0, txt: txt, col: col });
  }

  function curScore() { return Math.floor(time * 10) + bonus; }

  window.ARCADE.register({
    id: 'dodge', name: 'Asteroid Dodge', steer: true, icon: '🚀',
    hint: 'Move the pointer — dodge everything, graze for bonus',
    hintTouch: 'Drag anywhere — boosted steering, finger never covers the ship · or 🧭 Tilt',

    start: function (api) {
      ship = { x: api.W / 2, y: api.H * 0.6, vx: 0, vy: 0 };
      tilt = 0;
      asteroids = [];
      floats = [];
      pickup = null;
      stars = [];
      for (var i = 0; i < 40; i++) {
        stars.push({
          fx: api.rand(0, 1), fy: api.rand(0, 1),
          r: api.rand(0.6, 1.8), s: api.rand(0.004, 0.018),
          tw: api.rand(0, 6.283)
        });
      }
      time = 0; spawnT = 0.8; pickupT = api.rand(6, 9);
      shield = false; inv = 0; dead = false;
      bonus = 0; lastScore = -1;
      hasInput = !!(api.pointer.x || api.pointer.y);
      api.setScore(0);
    },

    step: function (dt, api) {
      if (dead || dt <= 0) return;
      time += dt;
      if (inv > 0) inv -= dt;

      // --- ship follows pointer (lerp) ---
      var tx = hasInput ? api.pointer.x : api.W / 2;
      var ty = hasInput ? api.pointer.y : api.H * 0.6;
      var ox = ship.x, oy = ship.y;
      var k = Math.min(1, dt * 10);
      ship.x += (tx - ship.x) * k;
      ship.y += (ty - ship.y) * k;
      ship.x = Math.max(SHIP_R, Math.min(api.W - SHIP_R, ship.x));
      ship.y = Math.max(SHIP_R, Math.min(api.H - SHIP_R, ship.y));
      ship.vx = (ship.x - ox) / dt;
      ship.vy = (ship.y - oy) / dt;
      var tt = Math.max(-0.55, Math.min(0.55, ship.vx * 0.0016));
      tilt += (tt - tilt) * Math.min(1, dt * 12);

      // --- starfield drift ---
      var i;
      for (i = 0; i < stars.length; i++) {
        stars[i].fy += stars[i].s * dt;
        if (stars[i].fy > 1.02) { stars[i].fy -= 1.04; stars[i].fx = api.rand(0, 1); }
      }

      // --- spawning, ramps with time ---
      spawnT -= dt;
      if (spawnT <= 0) {
        spawnAst(api);
        if (time > 35 && api.rand(0, 1) < 0.3) spawnAst(api);
        var iv = Math.max(0.26, 1.05 - time * 0.018);
        spawnT = iv * api.rand(0.7, 1.3);
      }
      if (asteroids.length > 70) asteroids.splice(0, asteroids.length - 70);

      // --- shield pickup ---
      if (!pickup) {
        pickupT -= dt;
        if (pickupT <= 0) spawnPickup(api);
      } else {
        pickup.t += dt;
        pickup.x += pickup.vx * dt;
        var py = pickup.baseY + Math.sin(pickup.t * 2.4) * 14;
        var pdx = pickup.x - ship.x, pdy = py - ship.y;
        if (pdx * pdx + pdy * pdy < (SHIP_R + 13) * (SHIP_R + 13)) {
          api.spawnParticles(pickup.x, py, api.colors.green, 18);
          if (shield) {
            bonus += 25;
            addFloat(ship.x, ship.y - 26, '+25', api.colors.green);
          } else {
            shield = true;
            addFloat(ship.x, ship.y - 26, 'SHIELD UP', api.colors.green);
          }
          if (!firstShield) {
            firstShield = true;
            api.toast('🛡️ Shield acquired <span class="xp">+15 XP</span>');
          }
          pickup = null; pickupT = api.rand(11, 16);
        } else if ((pickup.vx > 0 && pickup.x > api.W + 30) || (pickup.vx < 0 && pickup.x < -30)) {
          pickup = null; pickupT = api.rand(11, 16);
        }
      }

      // --- asteroids: move, graze, collide ---
      for (i = asteroids.length - 1; i >= 0; i--) {
        var a = asteroids[i];
        a.x += a.vx * dt; a.y += a.vy * dt; a.rot += a.rs * dt;
        if (a.x < -160 || a.x > api.W + 160 || a.y < -160 || a.y > api.H + 160) {
          asteroids.splice(i, 1); continue;
        }
        var dx = a.x - ship.x, dy = a.y - ship.y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        var hitR = a.r * 0.82 + SHIP_R * 0.8;
        if (dist < hitR && inv <= 0) {
          if (shield) {
            shield = false; inv = 1.2;
            api.spawnParticles(ship.x, ship.y, api.colors.green, 26);
            api.spawnParticles(a.x, a.y, '#8fa2c0', 14);
            api.shake(6);
            addFloat(ship.x, ship.y - 26, 'SHIELD DOWN', api.colors.white);
            asteroids.splice(i, 1);
          } else {
            dead = true;
            api.spawnParticles(ship.x, ship.y, api.colors.accent, 46);
            api.spawnParticles(ship.x, ship.y, api.colors.gold, 20);
            api.shake(10);
            var sc = curScore();
            api.setScore(sc);
            api.gameOver(sc);
            return;
          }
        } else if (!a.grazed && inv <= 0 && dist >= hitR && dist < a.r + SHIP_R + 16) {
          a.grazed = true;
          bonus += 5;
          var mx = ship.x + dx * 0.5, my = ship.y + dy * 0.5;
          api.spawnParticles(mx, my, api.colors.gold, 6);
          addFloat(mx, my - 8, 'graze +5', api.colors.gold);
          if (!firstGraze) {
            firstGraze = true;
            api.toast('✨ Close call! Graze bonus <span class="xp">+10 XP</span>');
          }
        }
      }

      // --- floating texts ---
      for (i = floats.length - 1; i >= 0; i--) {
        floats[i].t += dt;
        if (floats[i].t > 0.9) floats.splice(i, 1);
      }

      // --- score ---
      var s2 = curScore();
      if (s2 !== lastScore) { lastScore = s2; api.setScore(s2); }
    },

    draw: function (ctx, api) {
      var i, j;

      // starfield (behind everything)
      ctx.save();
      ctx.fillStyle = api.colors.white;
      for (i = 0; i < stars.length; i++) {
        var st = stars[i];
        ctx.globalAlpha = 0.2 + 0.35 * (0.5 + 0.5 * Math.sin(time * 1.3 + st.tw));
        ctx.beginPath();
        ctx.arc(st.fx * api.W, st.fy * api.H, st.r, 0, 6.283);
        ctx.fill();
      }
      ctx.restore();

      // shield pickup
      if (pickup) {
        var py = pickup.baseY + Math.sin(pickup.t * 2.4) * 14;
        ctx.save();
        var pul = 0.6 + 0.4 * Math.sin(time * 5);
        ctx.globalAlpha = 0.25 * pul;
        ctx.fillStyle = api.colors.green;
        ctx.beginPath(); ctx.arc(pickup.x, py, 17, 0, 6.283); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.arc(pickup.x, py, 10, 0, 6.283);
        ctx.fillStyle = 'rgba(43,214,123,0.25)'; ctx.fill();
        ctx.strokeStyle = api.colors.green; ctx.lineWidth = 2; ctx.stroke();
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('🛡️', pickup.x, py + 1);
        ctx.restore();
      }

      // asteroids
      for (i = 0; i < asteroids.length; i++) {
        var a = asteroids[i];
        ctx.save();
        ctx.translate(a.x, a.y);
        ctx.rotate(a.rot);
        ctx.beginPath();
        var n = a.verts.length;
        for (j = 0; j < n; j++) {
          var an = j / n * 6.283;
          var rr = a.r * a.verts[j];
          if (j === 0) ctx.moveTo(Math.cos(an) * rr, Math.sin(an) * rr);
          else ctx.lineTo(Math.cos(an) * rr, Math.sin(an) * rr);
        }
        ctx.closePath();
        ctx.fillStyle = a.col; ctx.fill();
        ctx.strokeStyle = 'rgba(11,17,32,0.6)'; ctx.lineWidth = 2; ctx.stroke();
        ctx.beginPath();
        ctx.arc(a.r * 0.25, -a.r * 0.2, a.r * 0.18, 0, 6.283);
        ctx.fillStyle = 'rgba(11,17,32,0.25)'; ctx.fill();
        ctx.restore();
      }

      // ship
      if (!dead) {
        ctx.save();
        ctx.translate(ship.x, ship.y);
        ctx.rotate(tilt);
        if (inv > 0 && Math.floor(time * 16) % 2 === 0) ctx.globalAlpha = 0.35;
        // engine flame flicker
        var fl = 12 + api.rand(0, 9);
        var g = ctx.createLinearGradient(0, 8, 0, 8 + fl);
        g.addColorStop(0, api.colors.accent2);
        g.addColorStop(1, 'rgba(249,0,77,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(-4.5, 8); ctx.lineTo(0, 8 + fl); ctx.lineTo(4.5, 8);
        ctx.closePath(); ctx.fill();
        // hull
        ctx.beginPath();
        ctx.moveTo(0, -15); ctx.lineTo(10, 10); ctx.lineTo(0, 5); ctx.lineTo(-10, 10);
        ctx.closePath();
        ctx.fillStyle = api.colors.white; ctx.fill();
        ctx.strokeStyle = 'rgba(11,17,32,0.35)'; ctx.lineWidth = 1.5; ctx.stroke();
        // cockpit
        ctx.beginPath(); ctx.arc(0, -3, 3, 0, 6.283);
        ctx.fillStyle = api.colors.accent; ctx.fill();
        ctx.restore();

        // shield ring
        if (shield) {
          ctx.save();
          var srr = 22 + Math.sin(time * 6) * 2;
          ctx.strokeStyle = api.colors.green;
          ctx.globalAlpha = 0.9; ctx.lineWidth = 2.5;
          ctx.beginPath(); ctx.arc(ship.x, ship.y, srr, 0, 6.283); ctx.stroke();
          ctx.globalAlpha = 0.25; ctx.lineWidth = 7;
          ctx.beginPath(); ctx.arc(ship.x, ship.y, srr, 0, 6.283); ctx.stroke();
          ctx.restore();
        }
      }

      // floating texts
      if (floats.length) {
        ctx.save();
        ctx.textAlign = 'center';
        ctx.font = '800 15px Montserrat, sans-serif';
        for (i = 0; i < floats.length; i++) {
          var f = floats[i];
          var p = f.t / 0.9;
          ctx.globalAlpha = Math.max(0, 1 - p);
          ctx.fillStyle = f.col;
          ctx.fillText(f.txt, f.x, f.y - p * 38);
        }
        ctx.restore();
      }
    },

    pointerDown: function (p, api) { hasInput = true; },
    pointerMove: function (p, api) { hasInput = true; }
  });
})();

/* ============================================================
   Game 6: Tech Memory
   ============================================================ */
(function () { 'use strict';

  var LABELS = ['Unity', 'C#', 'VR', 'AR', 'Web3', 'HDRP', 'PUN2', 'FPS'];

  var cards, flipped, unflipTimer, moves, elapsed, matchedPairs, score, shownScore;
  var over, winning, winTimer, confettiAcc, floats, effects, firstMatch, streak, t;
  var pairColors, confettiColors;

  function easeOutBack(u) {
    var c1 = 1.70158, c3 = c1 + 1, v = u - 1;
    return 1 + c3 * v * v * v + c1 * v * v;
  }

  function layout(api) {
    var topH = 48, gap = 10, padX = 12;
    var availW = api.W - padX * 2;
    var availH = api.H - topH - 14;
    var cw = Math.min((availW - gap * 3) / 4, 170);
    var ch = Math.min((availH - gap * 3) / 4, 96, cw * 1.4);
    var gw = cw * 4 + gap * 3, gh = ch * 4 + gap * 3;
    return {
      cw: cw, ch: ch, gap: gap, gw: gw, gh: gh, topH: topH,
      x0: (api.W - gw) / 2,
      y0: Math.max(topH + 4, topH + (api.H - topH - gh) / 2)
    };
  }

  function cardCenter(i, L) {
    var col = i % 4, row = (i / 4) | 0;
    return {
      x: L.x0 + col * (L.cw + L.gap) + L.cw / 2,
      y: L.y0 + row * (L.ch + L.gap) + L.ch / 2
    };
  }

  function cardAt(px, py, L) {
    var i, col, row, x, y;
    for (i = 0; i < 16; i++) {
      col = i % 4; row = (i / 4) | 0;
      x = L.x0 + col * (L.cw + L.gap);
      y = L.y0 + row * (L.ch + L.gap);
      if (px >= x && px <= x + L.cw && py >= y && py <= y + L.ch) return i;
    }
    return -1;
  }

  function doUnflip() {
    var i;
    for (i = 0; i < flipped.length; i++) cards[flipped[i]].target = 0;
    flipped = [];
  }

  function fmtTime(sec) {
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  window.ARCADE.register({
    id: 'memory', name: 'Tech Memory', icon: '🧠',
    hint: 'Flip two cards — match my tech stack',

    start: function (api) {
      var c = api.colors, deck = [], i, j, tmp;
      pairColors = ['#e8ecf3', '#9b5cff', c.accent, '#2bd6d6', c.gold, c.blue, c.green, '#ff7a3d'];
      confettiColors = [c.accent, c.gold, c.blue, c.green, c.accent2, '#9b5cff'];
      for (i = 0; i < 8; i++) { deck.push(i); deck.push(i); }
      for (i = 15; i > 0; i--) {
        j = Math.floor(api.rand(0, i + 1));
        tmp = deck[i]; deck[i] = deck[j]; deck[j] = tmp;
      }
      cards = [];
      for (i = 0; i < 16; i++) {
        cards.push({
          pair: deck[i], a: 0, target: 0, matched: false,
          pop: 0, glow: 0, deal: -i * 0.045, shim: api.rand(0, 1.8)
        });
      }
      flipped = []; unflipTimer = 0; moves = 0; elapsed = 0; matchedPairs = 0;
      score = 1000; shownScore = 1000; over = false; winning = false; winTimer = 0;
      confettiAcc = 0; floats = []; effects = []; firstMatch = false; streak = 0; t = 0;
      api.setScore(1000);
    },

    step: function (dt, api) {
      var i, c, e, L, s;
      if (over) return;
      t += dt;
      if (!winning) elapsed += dt;

      for (i = 0; i < 16; i++) {
        c = cards[i];
        c.deal += dt;
        if (c.a < c.target) c.a = Math.min(c.target, c.a + dt / 0.18);
        else if (c.a > c.target) c.a = Math.max(c.target, c.a - dt / 0.18);
        if (c.pop > 0) c.pop -= dt;
        if (c.glow > 0) c.glow -= dt * 1.4;
      }

      for (i = effects.length - 1; i >= 0; i--) {
        e = effects[i];
        e.t -= dt;
        if (e.t <= 0) {
          api.spawnParticles(e.x, e.y, e.color, e.n);
          cards[e.card].pop = 0.32;
          cards[e.card].glow = 1;
          effects.splice(i, 1);
        }
      }

      if (unflipTimer > 0) {
        unflipTimer -= dt;
        if (unflipTimer <= 0) doUnflip();
      }

      for (i = floats.length - 1; i >= 0; i--) {
        floats[i].life -= dt;
        floats[i].y -= 30 * dt;
        if (floats[i].life <= 0) floats.splice(i, 1);
      }

      if (winning) {
        confettiAcc -= dt;
        while (confettiAcc <= 0) {
          confettiAcc += 0.09;
          api.spawnParticles(
            api.rand(api.W * 0.1, api.W * 0.9),
            api.rand(api.H * 0.1, api.H * 0.6),
            confettiColors[Math.floor(api.rand(0, confettiColors.length))],
            10
          );
        }
        winTimer -= dt;
        if (winTimer <= 0) {
          over = true;
          api.gameOver(score, 'YOU WIN!');
        }
        return;
      }

      s = Math.max(0, 1000 - moves * 15 - Math.floor(elapsed) * 5);
      score = s;
      if (s !== shownScore) { shownScore = s; api.setScore(s); }
    },

    pointerDown: function (p, api) {
      var L, i, c, a, b, ca, cb, mx, my;
      if (over || winning) return;
      if (unflipTimer > 0) { unflipTimer = 0; doUnflip(); }
      L = layout(api);
      i = cardAt(p.x, p.y, L);
      if (i < 0) return;
      c = cards[i];
      if (c.deal <= 0 || c.matched || c.target === 1 || flipped.length >= 2) return;

      c.target = 1;
      flipped.push(i);

      if (flipped.length === 2) {
        moves++;
        a = cards[flipped[0]]; b = cards[flipped[1]];
        ca = cardCenter(flipped[0], L); cb = cardCenter(flipped[1], L);
        if (a.pair === b.pair) {
          a.matched = true; b.matched = true;
          matchedPairs++; streak++;
          effects.push({ t: 0.2, x: ca.x, y: ca.y, color: pairColors[a.pair], n: 14, card: flipped[0] });
          effects.push({ t: 0.2, x: cb.x, y: cb.y, color: pairColors[b.pair], n: 14, card: flipped[1] });
          mx = (ca.x + cb.x) / 2; my = (ca.y + cb.y) / 2 - L.ch * 0.35;
          floats.push({
            x: mx, y: my,
            txt: streak > 1 ? 'COMBO x' + streak + '!' : 'MATCH!',
            color: streak > 1 ? api.colors.gold : api.colors.green,
            life: 1.1
          });
          if (!firstMatch) {
            firstMatch = true;
            api.toast('🏆 First tech match <span class="xp">+15 XP</span>');
          }
          flipped = [];
          if (matchedPairs === 8) {
            score = Math.max(0, 1000 - moves * 15 - Math.floor(elapsed) * 5);
            api.setScore(score);
            winning = true; winTimer = 1.3; confettiAcc = 0;
            api.shake(7);
          }
        } else {
          streak = 0;
          unflipTimer = 0.72;
          api.shake(4);
        }
      }
    },

    draw: function (ctx, api) {
      var L = layout(api), cols = api.colors;
      var i, c, col, row, x, y, cx, cy, w, h, dealU, s0, p, sx, face, pc;
      var grad, u, bx, fs, chipW, f, alpha, ptr, hov, wu, ws;

      ctx.save();
      ctx.textBaseline = 'middle';

      ctx.textAlign = 'left';
      ctx.font = '700 10px Montserrat, sans-serif';
      ctx.fillStyle = cols.muted;
      ctx.fillText('MOVES', L.x0, 16);
      ctx.font = '800 18px Montserrat, sans-serif';
      ctx.fillStyle = cols.white;
      ctx.fillText('' + moves, L.x0, 34);

      ctx.textAlign = 'center';
      ctx.font = '700 10px Montserrat, sans-serif';
      ctx.fillStyle = cols.muted;
      ctx.fillText('PAIRS', api.W / 2, 16);
      ctx.font = '800 18px Montserrat, sans-serif';
      ctx.fillStyle = cols.accent;
      ctx.fillText(matchedPairs + '/8', api.W / 2, 34);

      ctx.textAlign = 'right';
      ctx.font = '700 10px Montserrat, sans-serif';
      ctx.fillStyle = cols.muted;
      ctx.fillText('TIME', L.x0 + L.gw, 16);
      ctx.font = '800 18px Montserrat, sans-serif';
      ctx.fillStyle = cols.white;
      ctx.fillText(fmtTime(elapsed), L.x0 + L.gw, 34);

      ptr = api.pointer;
      w = L.cw; h = L.ch;

      for (i = 0; i < 16; i++) {
        c = cards[i];
        if (c.deal <= 0) continue;
        col = i % 4; row = (i / 4) | 0;
        x = L.x0 + col * (w + L.gap);
        y = L.y0 + row * (h + L.gap);
        cx = x + w / 2; cy = y + h / 2;

        dealU = Math.min(1, c.deal / 0.28);
        s0 = easeOutBack(dealU);
        if (c.pop > 0) s0 *= 1 + 0.16 * Math.sin(((0.32 - c.pop) / 0.32) * Math.PI);

        hov = false;
        if (dealU >= 1 && !c.matched && c.target === 0 && flipped.length < 2 && !winning &&
            ptr.x >= x && ptr.x <= x + w && ptr.y >= y && ptr.y <= y + h) {
          hov = true;
          s0 *= 1.035;
        }

        p = c.a;
        sx = Math.max(0.02, Math.abs(Math.cos(Math.PI * p)));
        face = p > 0.5;

        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(sx * s0, s0);

        if (!face) {
          grad = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
          grad.addColorStop(0, '#141e38');
          grad.addColorStop(1, '#0d1428');
          api.roundRect(ctx, -w / 2, -h / 2, w, h, 12);
          ctx.fillStyle = grad;
          ctx.fill();
          ctx.strokeStyle = hov ? cols.accent2 : 'rgba(249,0,77,0.55)';
          ctx.lineWidth = 2;
          ctx.stroke();

          u = ((t * 0.45 + c.shim) % 1.8) - 0.4;
          bx = -w / 2 + u * w;
          ctx.save();
          api.roundRect(ctx, -w / 2, -h / 2, w, h, 12);
          ctx.clip();
          grad = ctx.createLinearGradient(bx - w * 0.28, -h * 0.3, bx + w * 0.28, h * 0.3);
          grad.addColorStop(0, 'rgba(255,255,255,0)');
          grad.addColorStop(0.5, 'rgba(255,255,255,0.07)');
          grad.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = grad;
          ctx.fillRect(-w / 2, -h / 2, w, h);
          ctx.restore();

          ctx.globalAlpha = 0.55 + 0.2 * Math.sin(t * 2 + i * 0.7);
          ctx.fillStyle = cols.accent;
          ctx.font = '800 ' + Math.round(Math.min(h * 0.42, w * 0.5)) + 'px Montserrat, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('?', 0, 2);
          ctx.globalAlpha = 1;
        } else {
          pc = pairColors[c.pair];
          if (c.matched) {
            ctx.shadowColor = pc;
            ctx.shadowBlur = 14 * Math.max(c.glow, 0.25);
          }
          api.roundRect(ctx, -w / 2, -h / 2, w, h, 12);
          ctx.fillStyle = '#17223f';
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.strokeStyle = pc;
          ctx.lineWidth = 2;
          ctx.stroke();

          chipW = Math.min(w * 0.42, 36);
          api.roundRect(ctx, -chipW / 2, -h * 0.26, chipW, 7, 3.5);
          ctx.fillStyle = pc;
          ctx.fill();

          fs = Math.max(12, Math.min(18, w * 0.19));
          ctx.fillStyle = cols.white;
          ctx.font = '800 ' + Math.round(fs) + 'px Montserrat, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(LABELS[c.pair], 0, h * 0.12);
        }
        ctx.restore();
      }

      ctx.textAlign = 'center';
      for (i = 0; i < floats.length; i++) {
        f = floats[i];
        alpha = Math.min(1, f.life * 2.2);
        ctx.globalAlpha = alpha;
        ctx.font = '800 20px Montserrat, sans-serif';
        ctx.fillStyle = f.color;
        ctx.fillText(f.txt, f.x, f.y);
      }
      ctx.globalAlpha = 1;

      if (winning) {
        wu = Math.min(1, (1.3 - winTimer) / 0.3);
        ws = easeOutBack(wu);
        ctx.save();
        ctx.translate(api.W / 2, api.H / 2);
        ctx.scale(ws, ws);
        ctx.font = '800 ' + Math.round(Math.min(api.W * 0.085, 44)) + 'px Montserrat, sans-serif';
        ctx.shadowColor = cols.accent;
        ctx.shadowBlur = 24;
        ctx.fillStyle = cols.gold;
        ctx.fillText('PERFECT RECALL!', 0, 0);
        ctx.restore();
      }

      ctx.restore();
    }
  });
})();

/* ============================================================
   Game 7: Commit Catcher
   ============================================================ */
(function () { 'use strict';

  var HASH_CHARS = '0123456789abcdef';

  var score, lives, t, items, floats, combo, comboT, px, spawnT, starT, starNext,
      over, flashT, bump, toastDodge, toastStreak;

  function makeHash() {
    var s = '', i;
    for (i = 0; i < 7; i++) s += HASH_CHARS.charAt(Math.floor(Math.random() * 16));
    return s;
  }

  function addFloat(x, y, txt, color, size) {
    floats.push({ x: x, y: y, txt: txt, color: color, size: size || 14, t: 0, life: 0.95 });
    if (floats.length > 24) floats.shift();
  }

  function paddleW(api) { return Math.max(74, Math.min(132, api.W * 0.12)); }
  function paddleY(api) { return api.H - 58; }
  function floorY(api) { return api.H - 14; }
  function baseSpeed() { return Math.min(430, 150 + t * 7); }

  function spawnItem(api) {
    var pC = Math.min(0.34, 0.15 + t * 0.005);
    var isC = api.rand(0, 1) < pC;
    var w = isC ? 74 : 62;
    var h = isC ? 34 : 28;
    if (api.W < 420) { w *= 0.88; h *= 0.92; }
    items.push({
      type: isC ? 'conflict' : 'commit',
      x: api.rand(w / 2 + 12, api.W - w / 2 - 12),
      y: -h, w: w, h: h,
      vy: baseSpeed() * api.rand(0.85, 1.2) * (isC ? 0.9 : 1),
      hash: makeHash(),
      ph: api.rand(0, 6.28)
    });
  }

  function spawnStar(api) {
    if (items.length >= 60) return;
    items.push({
      type: 'star',
      x: api.rand(30, api.W - 30),
      y: -26, w: 28, h: 28,
      vy: baseSpeed() * 1.65,
      hash: '', ph: api.rand(0, 6.28)
    });
  }

  function starPath(ctx, r) {
    var i, a, rr;
    ctx.beginPath();
    for (i = 0; i < 10; i++) {
      a = -Math.PI / 2 + i * Math.PI / 5;
      rr = (i % 2 === 0) ? r : r * 0.45;
      if (i === 0) ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
      else ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath();
  }

  function drawLife(ctx, x, y, on, api) {
    ctx.save();
    ctx.globalAlpha = on ? 1 : 0.22;
    ctx.strokeStyle = on ? api.colors.green : api.colors.muted;
    ctx.fillStyle = on ? api.colors.green : api.colors.muted;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x, y + 16); ctx.lineTo(x, y + 5); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y + 11); ctx.quadraticCurveTo(x + 7, y + 10, x + 8, y + 4); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y + 16, 3, 0, 6.283); ctx.fill();
    ctx.beginPath(); ctx.arc(x, y + 3, 3, 0, 6.283); ctx.fill();
    ctx.beginPath(); ctx.arc(x + 8, y + 2, 2.5, 0, 6.283); ctx.fill();
    ctx.restore();
  }

  window.ARCADE.register({
    id: 'catcher', name: 'Commit Catcher', steer: true, icon: '🧺',
    hint: 'Move the pointer — catch commits, dodge conflicts',
    hintTouch: 'Drag anywhere to move the basket · or 🧭 Tilt',

    start: function (api) {
      score = 0; lives = 3; t = 0;
      items = []; floats = [];
      combo = 0; comboT = 0;
      px = api.W / 2;
      spawnT = 0.9;
      starT = 0; starNext = 8 + api.rand(0, 4);
      over = false; flashT = 0; bump = 0;
      toastDodge = false; toastStreak = false;
      api.setScore(0);
    },

    step: function (dt, api) {
      if (over) return;
      t += dt;
      bump = Math.max(0, bump - dt * 5);
      flashT = Math.max(0, flashT - dt);
      if (comboT > 0) { comboT -= dt; if (comboT <= 0) combo = 0; }

      var pw = paddleW(api);
      var target = (api.pointer.x === 0 && api.pointer.y === 0) ? px : api.pointer.x;
      target = Math.max(pw / 2 + 4, Math.min(api.W - pw / 2 - 4, target));
      px += (target - px) * Math.min(1, dt * 14);

      spawnT -= dt;
      if (spawnT <= 0 && items.length < 40) {
        spawnItem(api);
        spawnT = Math.max(0.42, 1.25 - t * 0.02) * api.rand(0.8, 1.2);
      }
      starT += dt;
      if (starT >= starNext) { spawnStar(api); starT = 0; starNext = 11 + api.rand(0, 5); }

      var pTop = paddleY(api), fl = floorY(api), i, it, bottom, caught, pts;
      for (i = items.length - 1; i >= 0; i--) {
        it = items[i];
        it.y += it.vy * dt;
        it.x += Math.sin(t * 2 + it.ph) * 12 * dt;
        if (it.x < it.w / 2) it.x = it.w / 2;
        if (it.x > api.W - it.w / 2) it.x = api.W - it.w / 2;

        bottom = it.y + it.h / 2;
        caught = bottom >= pTop && (it.y - it.h / 2) < pTop + 18 &&
                 Math.abs(it.x - px) < pw / 2 + it.w * 0.3;

        if (caught) {
          if (it.type === 'commit') {
            combo = (comboT > 0) ? combo + 1 : 1;
            comboT = 1.8;
            pts = combo;
            score += pts;
            api.setScore(score);
            bump = 1;
            api.spawnParticles(it.x, pTop, api.colors.green, 10);
            addFloat(it.x, pTop - 14, combo > 1 ? '+' + pts + '  x' + combo : '+1',
                     combo > 1 ? api.colors.gold : api.colors.green, combo > 1 ? 17 : 14);
            if (combo === 5 && !toastStreak) {
              toastStreak = true;
              api.toast('🔥 Clean history x5 <span class="xp">+20 XP</span>');
            }
          } else if (it.type === 'conflict') {
            lives--; combo = 0; comboT = 0;
            flashT = 0.3;
            api.shake(8);
            api.spawnParticles(it.x, pTop, api.colors.accent2, 22);
            addFloat(it.x, pTop - 18, 'MERGE CONFLICT!', api.colors.accent2, 17);
          } else {
            score += 5;
            api.setScore(score);
            bump = 1;
            if (lives < 3) { lives++; addFloat(px, pTop - 36, '+1 life', api.colors.gold, 13); }
            api.spawnParticles(it.x, pTop, api.colors.gold, 24);
            addFloat(it.x, pTop - 16, '+5 HOTFIX', api.colors.gold, 17);
          }
          items.splice(i, 1);
          if (lives <= 0) { over = true; api.gameOver(score, 'REPO BROKEN'); return; }
          continue;
        }

        if (bottom >= fl) {
          if (it.type === 'commit') {
            lives--; combo = 0; comboT = 0;
            api.shake(5);
            api.spawnParticles(it.x, fl, api.colors.accent, 12);
            addFloat(it.x, fl - 20, '-1 commit lost', api.colors.accent2, 14);
          } else if (it.type === 'conflict') {
            api.spawnParticles(it.x, fl, api.colors.muted, 18);
            addFloat(it.x, fl - 20, 'conflict dodged', api.colors.muted, 12);
            if (!toastDodge) {
              toastDodge = true;
              api.toast('🏆 First conflict dodged <span class="xp">+15 XP</span>');
            }
          } else {
            api.spawnParticles(it.x, fl, api.colors.gold, 8);
          }
          items.splice(i, 1);
          if (lives <= 0) { over = true; api.gameOver(score, 'REPO BROKEN'); return; }
        }
      }

      for (i = floats.length - 1; i >= 0; i--) {
        floats[i].t += dt;
        floats[i].y -= 42 * dt;
        if (floats[i].t >= floats[i].life) floats.splice(i, 1);
      }
    },

    draw: function (ctx, api) {
      var i, it, f, g, teeth, tx, step, fl = floorY(api);
      var pw = paddleW(api), pTop = paddleY(api), phh = 30;

      ctx.save();
      ctx.strokeStyle = 'rgba(138,147,165,0.25)';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 8]);
      ctx.beginPath(); ctx.moveTo(0, fl); ctx.lineTo(api.W, fl); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      for (i = 0; i < items.length; i++) {
        it = items[i];
        ctx.save();
        ctx.translate(it.x, it.y);

        if (it.type === 'commit') {
          ctx.rotate(Math.sin(t * 2 + it.ph) * 0.08);
          g = ctx.createLinearGradient(0, -it.h / 2, 0, it.h / 2);
          g.addColorStop(0, '#3ee68d');
          g.addColorStop(1, '#1fa862');
          api.roundRect(ctx, -it.w / 2, -it.h / 2, it.w, it.h, 7);
          ctx.fillStyle = g; ctx.fill();
          api.roundRect(ctx, -it.w / 2, -it.h / 2, it.w, it.h, 7);
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = 'rgba(232,236,243,0.35)'; ctx.stroke();
          ctx.fillStyle = api.colors.ink;
          ctx.font = '700 10px "Courier New", monospace';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(it.hash, 0, 1);
        } else if (it.type === 'conflict') {
          ctx.rotate(Math.sin(t * 1.7 + it.ph) * 0.06);
          teeth = Math.max(4, Math.round(it.w / 11));
          step = it.w / teeth;
          ctx.beginPath();
          ctx.moveTo(-it.w / 2, -it.h / 2 + 7);
          for (tx = 0; tx < teeth; tx++) {
            ctx.lineTo(-it.w / 2 + step * (tx + 0.5), -it.h / 2);
            ctx.lineTo(-it.w / 2 + step * (tx + 1), -it.h / 2 + 7);
          }
          ctx.lineTo(it.w / 2, it.h / 2);
          ctx.lineTo(-it.w / 2, it.h / 2);
          ctx.closePath();
          g = ctx.createLinearGradient(0, -it.h / 2, 0, it.h / 2);
          g.addColorStop(0, api.colors.accent2);
          g.addColorStop(1, '#b30036');
          ctx.fillStyle = g; ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = 'rgba(255,61,113,0.8)'; ctx.stroke();
          ctx.fillStyle = api.colors.white;
          ctx.font = '800 9px "Courier New", monospace';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText('<<<< HEAD', 0, 4);
        } else {
          ctx.rotate(t * 2 + it.ph);
          ctx.scale(1 + Math.sin(t * 6 + it.ph) * 0.1, 1 + Math.sin(t * 6 + it.ph) * 0.1);
          ctx.shadowColor = api.colors.gold;
          ctx.shadowBlur = 16;
          starPath(ctx, 13);
          ctx.fillStyle = api.colors.gold; ctx.fill();
          ctx.shadowBlur = 0;
          starPath(ctx, 13);
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = '#ffe9b0'; ctx.stroke();
        }
        ctx.restore();
      }

      ctx.save();
      ctx.translate(px, pTop + phh / 2 + bump * 2);
      ctx.scale(1 + bump * 0.06, 1 - bump * 0.08);
      api.roundRect(ctx, -pw / 2, -phh / 2, pw, phh, 10);
      ctx.fillStyle = 'rgba(249,0,77,0.14)'; ctx.fill();
      api.roundRect(ctx, -pw / 2, -phh / 2, pw, phh, 10);
      ctx.lineWidth = 2;
      ctx.strokeStyle = api.colors.accent; ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-pw / 2 + 6, -phh / 2 + 5);
      ctx.lineTo(pw / 2 - 6, -phh / 2 + 5);
      ctx.strokeStyle = 'rgba(249,0,77,0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = api.colors.white;
      ctx.font = '700 12px Montserrat, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('main', 0, 3);
      ctx.restore();

      if (combo >= 2 && comboT > 0) {
        ctx.save();
        ctx.globalAlpha = Math.min(1, comboT * 2);
        ctx.fillStyle = api.colors.gold;
        ctx.font = '800 16px Montserrat, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        ctx.fillText('x' + combo, px, pTop - 10);
        ctx.restore();
      }

      for (i = 0; i < floats.length; i++) {
        f = floats[i];
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - f.t / f.life);
        ctx.fillStyle = f.color;
        ctx.font = '800 ' + f.size + 'px Montserrat, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        ctx.fillText(f.txt, f.x, f.y);
        ctx.restore();
      }

      for (i = 0; i < 3; i++) drawLife(ctx, 18 + i * 24, 12, i < lives, api);

      if (flashT > 0) {
        ctx.save();
        ctx.globalAlpha = (flashT / 0.3) * 0.3;
        ctx.fillStyle = api.colors.accent;
        ctx.fillRect(0, 0, api.W, api.H);
        ctx.restore();
      }

      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }
  });
})();

/* ============================================================
   Game 8: Leak Popper
   ============================================================ */
(function () { 'use strict';

  var blobs = [];
  var floats = [];
  var score = 0;
  var t = 0;
  var spawnT = 0;
  var nullT = 0;
  var over = false;
  var crash = 0;
  var crashDone = false;
  var toastBig = false;
  var toastSave = false;
  var danger = false;
  var CAP = 300;

  function mbOf(b) { return Math.max(1, Math.round(b.r * b.r * 0.04)); }

  function usedMB() {
    var s = 0;
    for (var i = 0; i < blobs.length; i++) if (!blobs[i].isNull) s += mbOf(blobs[i]);
    return s;
  }

  function spawnBlob(api, isNull) {
    var m = Math.max(30, api.W * 0.05);
    blobs.push({
      x: api.rand(m, api.W - m),
      y: api.rand(84, api.H - 40),
      r: isNull ? api.rand(13, 17) : api.rand(6, 10),
      grow: api.rand(2.6, 4.2),
      ph: api.rand(0, 6.283),
      ws: api.rand(1.4, 2.8),
      rot: api.rand(0, 6.283),
      isNull: !!isNull,
      life: 4.2
    });
  }

  function addFloat(x, y, text, color, size) {
    floats.push({ x: x, y: y, t: 0, dur: 1.15, text: text, color: color, size: size || 17 });
  }

  window.ARCADE.register({
    id: 'leak', name: 'Leak Popper', icon: '💧',
    hint: 'Pop the memory leaks before RAM fills up',

    start: function (api) {
      blobs = []; floats = [];
      score = 0; t = 0; spawnT = 1.2; nullT = api.rand(7, 11);
      over = false; crash = 0; crashDone = false;
      toastBig = false; toastSave = false; danger = false;
      api.setScore(0);
      for (var i = 0; i < 3; i++) {
        spawnBlob(api, false);
        blobs[i].r = 8 + i * 5;
      }
    },

    step: function (dt, api) {
      var i, b;
      if (over) {
        if (crash > 0) {
          crash -= dt;
          if (crash <= 0 && !crashDone) {
            crashDone = true;
            api.gameOver(score, 'OUT OF MEMORY');
          }
        }
        return;
      }
      t += dt;

      spawnT -= dt;
      if (spawnT <= 0) {
        spawnT = Math.max(0.5, 2.1 - t * 0.028) * api.rand(0.7, 1.3);
        if (blobs.length < 34) spawnBlob(api, false);
      }
      nullT -= dt;
      if (nullT <= 0) {
        nullT = api.rand(6, 10);
        if (t > 6 && blobs.length < 38) spawnBlob(api, true);
      }

      var boost = Math.min(5, t * 0.055);
      var rcap = Math.min(60, api.W * 0.16);
      for (i = blobs.length - 1; i >= 0; i--) {
        b = blobs[i];
        b.x = Math.min(Math.max(b.x, 24), api.W - 24);
        b.y = Math.min(Math.max(b.y, 78), api.H - 24);
        if (b.isNull) {
          b.life -= dt;
          b.r = Math.min(b.r + dt * 1.5, 24);
          if (b.life <= 0) {
            api.spawnParticles(b.x, b.y, api.colors.muted, 8);
            addFloat(b.x, b.y, 'auto-GC', api.colors.muted, 13);
            blobs.splice(i, 1);
          }
        } else {
          b.r = Math.min(b.r + (b.grow + boost) * dt, rcap);
        }
      }

      for (i = floats.length - 1; i >= 0; i--) {
        floats[i].t += dt;
        if (floats[i].t >= floats[i].dur) floats.splice(i, 1);
      }

      var frac = usedMB() / CAP;
      if (frac >= 0.9) danger = true;
      if (danger && frac < 0.55 && !toastSave) {
        toastSave = true;
        api.toast('🏆 Heap almost died, you saved it <span class="xp">+20 XP</span>');
      }
      if (frac >= 1) {
        over = true; crash = 0.75;
        api.shake(10);
        for (i = 0; i < blobs.length; i++) {
          api.spawnParticles(blobs[i].x, blobs[i].y, i % 2 ? '#4fd8ff' : api.colors.blue, 12);
        }
        for (i = 0; i < 8; i++) {
          api.spawnParticles(api.rand(0, api.W), api.rand(0, api.H), api.colors.accent, 10);
        }
        blobs = [];
      }
    },

    pointerDown: function (p, api) {
      if (over) return;
      var hit = -1, i, b, dx, dy, d;
      for (i = blobs.length - 1; i >= 0; i--) {
        b = blobs[i];
        dx = p.x - b.x; dy = p.y - b.y;
        d = Math.sqrt(dx * dx + dy * dy);
        if (d <= Math.max(b.r, 13) + 4) { hit = i; break; }
      }
      if (hit < 0) { api.spawnParticles(p.x, p.y, api.colors.muted, 3); return; }
      b = blobs[hit];
      blobs.splice(hit, 1);
      if (b.isNull) {
        score = Math.max(0, score - 20);
        api.setScore(score);
        addFloat(b.x, b.y - b.r, '-20 null ref!', api.colors.accent2, 19);
        api.spawnParticles(b.x, b.y, api.colors.accent, 16);
        api.shake(6);
      } else {
        var mb = mbOf(b);
        score += mb;
        api.setScore(score);
        addFloat(b.x, b.y - b.r, '+' + mb + ' MB freed', mb >= 40 ? api.colors.gold : '#4fd8ff', mb >= 40 ? 22 : 17);
        api.spawnParticles(b.x, b.y, api.colors.blue, Math.min(26, 6 + Math.round(mb * 0.3)));
        api.spawnParticles(b.x, b.y, '#4fd8ff', Math.min(14, 4 + Math.round(mb * 0.15)));
        if (mb >= 60) api.shake(6);
        else if (mb >= 25) api.shake(4);
        if (mb > 40 && !toastBig) {
          toastBig = true;
          api.toast('🏆 Memory hog hunted (40+ MB) <span class="xp">+15 XP</span>');
        }
      }
    },

    draw: function (ctx, api) {
      var i, b, a, mb, fs;

      for (i = 0; i < blobs.length; i++) {
        b = blobs[i];
        if (b.isNull) {
          ctx.save();
          ctx.translate(b.x, b.y);
          ctx.rotate(b.rot + t * 1.3);
          var spikes = 11, outer = b.r * 1.25, inner = b.r * 0.8, k, ang, rr;
          ctx.beginPath();
          for (k = 0; k < spikes * 2; k++) {
            ang = (Math.PI * k) / spikes;
            rr = (k % 2 === 0) ? outer : inner;
            if (k === 0) ctx.moveTo(Math.cos(ang) * rr, Math.sin(ang) * rr);
            else ctx.lineTo(Math.cos(ang) * rr, Math.sin(ang) * rr);
          }
          ctx.closePath();
          ctx.fillStyle = 'rgba(249,0,77,0.78)';
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = api.colors.accent2;
          ctx.stroke();
          ctx.restore();
          ctx.beginPath();
          ctx.arc(b.x, b.y, b.r * 1.45, -Math.PI / 2, -Math.PI / 2 + (b.life / 4.2) * Math.PI * 2);
          ctx.lineWidth = 2;
          ctx.strokeStyle = 'rgba(255,180,0,0.7)';
          ctx.stroke();
          ctx.font = '700 10px Montserrat, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = api.colors.white;
          ctx.fillText('null', b.x, b.y);
        } else {
          a = Math.sin(t * b.ws + b.ph) * 0.07;
          ctx.save();
          ctx.translate(b.x, b.y);
          ctx.scale(1 + a, 1 - a);
          ctx.beginPath();
          ctx.arc(0, 0, b.r, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(61,150,255,0.26)';
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = 'rgba(97,214,255,0.8)';
          ctx.stroke();
          ctx.beginPath();
          ctx.ellipse(-b.r * 0.32, -b.r * 0.38, b.r * 0.28, b.r * 0.16, -0.6, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.3)';
          ctx.fill();
          ctx.restore();
          if (b.r >= 13) {
            mb = mbOf(b);
            fs = Math.max(9, Math.round(b.r * 0.38));
            ctx.font = '700 ' + fs + 'px Montserrat, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = mb >= 40 ? 'rgba(255,180,0,0.95)' : 'rgba(232,236,243,0.85)';
            ctx.fillText(mb + 'MB', b.x, b.y + b.r * 0.05);
          }
        }
      }

      if (!over) {
        for (i = blobs.length - 1; i >= 0; i--) {
          b = blobs[i];
          var hx = api.pointer.x - b.x, hy = api.pointer.y - b.y;
          if (Math.sqrt(hx * hx + hy * hy) <= Math.max(b.r, 13) + 4) {
            ctx.beginPath();
            ctx.arc(b.x, b.y, b.r + 5, 0, Math.PI * 2);
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = b.isNull ? 'rgba(255,61,113,0.7)' : 'rgba(255,255,255,0.55)';
            ctx.stroke();
            break;
          }
        }
      }

      for (i = 0; i < floats.length; i++) {
        var f = floats[i];
        var pr = f.t / f.dur;
        ctx.globalAlpha = 1 - pr;
        ctx.font = '800 ' + f.size + 'px Montserrat, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, f.x, f.y - pr * 42);
      }
      ctx.globalAlpha = 1;

      var used = usedMB();
      var frac = Math.min(1, used / CAP);
      var barX = 60, barY = 12, barW = api.W - barX - 16, barH = 14;
      ctx.font = '800 12px Montserrat, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = api.colors.muted;
      ctx.fillText('RAM', 16, barY + barH / 2 + 1);
      api.roundRect(ctx, barX, barY, barW, barH, 7);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fill();
      if (frac > 0) {
        var col = frac < 0.55 ? api.colors.green : (frac < 0.8 ? api.colors.gold : api.colors.accent);
        var fw = Math.max(6, barW * frac);
        api.roundRect(ctx, barX, barY, fw, barH, Math.min(7, fw / 2));
        if (frac > 0.85) ctx.globalAlpha = 0.75 + 0.25 * Math.sin(t * 9);
        ctx.fillStyle = col;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.font = '700 10px Montserrat, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillStyle = api.colors.white;
      ctx.fillText(used + '/' + CAP + ' MB', barX + barW - 6, barY + barH / 2 + 1);

      if (!over && frac > 0.85) {
        ctx.lineWidth = 12;
        ctx.strokeStyle = 'rgba(249,0,77,' + (0.22 + 0.18 * Math.sin(t * 9)).toFixed(3) + ')';
        ctx.strokeRect(4, 4, api.W - 8, api.H - 8);
      }

      if (over && crash > 0) {
        var ca = crash / 0.75;
        ctx.fillStyle = 'rgba(249,0,77,' + (0.35 * ca).toFixed(3) + ')';
        ctx.fillRect(0, 0, api.W, api.H);
        ctx.fillStyle = 'rgba(255,255,255,' + (0.6 * ca * ca).toFixed(3) + ')';
        ctx.fillRect(0, 0, api.W, api.H);
      }

      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.lineWidth = 1;
    }
  });
})();

/* ============================================================
   Game 9: Packet Pong  (single player vs AI + online 1v1)

   Online netcode (WebRTC DataChannel, see assets/js/netplay.js):
     host  — authoritative: simulates ball, scoring, serves;
             broadcasts state ~30Hz
     guest — sends its paddle position ~30Hz, renders host state
             with interpolation, predicts its own paddle locally
   ============================================================ */
(function () {
  'use strict';

  var score, over, elapsed, speed, rally, timeouts;
  var ball, trail, floats;
  var playerY, targetY, pointerActive, lastPX, lastPY;
  var aiY, aiTarget, aiReact;
  var squash, squashAxis;
  var serving, serveT, serveTotal;
  var toastTimeout, toastRally;

  /* ---- online state ---- */
  var net = null;                 // NETPLAY session
  var mode = 'ai';                // 'ai' | 'host' | 'guest'
  var netPhase = 'off';           // off | hosting | joining | code | live | ended
  var codeSlots = ['A', 'A', 'A', 'A'], codeSlot = 0;
  var lobbyBtns = null, copiedT = 0;
  var netMsg = '', netRoom = '', netLink = '';
  var myScore = 0, oppScore = 0;  // online rally scores
  var oppY = 0, oppTargetY = 0;   // remote paddle (interpolated)
  var netSendT = 0, netSeen = 0;
  var lastState = null;           // guest: latest authoritative snapshot
  var ballRender = { x: 0, y: 0 };
  var toastOnline = false;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function hit(b, p) { return b && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h; }
  function bumpCode(i, d) {
    var CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var idx = CH.indexOf(codeSlots[i]);
    if (idx < 0) idx = 0;
    codeSlots[i] = CH.charAt((idx + d + CH.length) % CH.length);
  }
  function tryJoinCode(api) {
    var room = codeSlots.join('');
    netMsg = '';
    startJoin(api, room);
  }

  function layout(api) {
    var pw = Math.max(10, Math.min(15, api.W * 0.012));
    var ph = Math.max(64, Math.min(110, api.H * 0.21));
    var m = Math.max(14, api.W * 0.03);
    return { pw: pw, ph: ph, m: m, planeL: m + pw, planeR: api.W - m - pw };
  }

  function baseSpeed(api) { return Math.max(250, api.W * 0.32); }
  function maxSpeed(api) { return Math.max(520, api.W * 1.05); }

  function addFloat(x, y, txt, color, size) {
    floats.push({ x: x, y: y, txt: txt, color: color, size: size, life: 1.15, vy: -34 });
  }

  function serve(delay) {
    serving = true;
    serveT = delay;
    serveTotal = delay;
    rally = 0;
    ball.vx = 0;
    ball.vy = 0;
    trail.length = 0;
  }

  function resetRun(api) {
    score = 0; over = false; elapsed = 0;
    timeouts = 0; rally = 0;
    speed = baseSpeed(api);
    ball = { x: api.W / 2, y: api.H / 2, vx: 0, vy: 0 };
    ballRender.x = ball.x; ballRender.y = ball.y;
    trail = [];
    floats = [];
    playerY = api.H / 2;
    targetY = api.H / 2;
    pointerActive = false;
    lastPX = api.pointer.x;
    lastPY = api.pointer.y;
    aiY = api.H / 2;
    aiTarget = api.H / 2;
    aiReact = 0;
    oppY = api.H / 2; oppTargetY = api.H / 2;
    squash = 0; squashAxis = 0;
    toastTimeout = false;
    toastRally = false;
    myScore = 0; oppScore = 0;
    netSendT = 0; netSeen = 0; lastState = null;
    serve(1.0);
    api.setScore(0);
  }

  /* ---------------- networking ---------------- */
  function netClose(reason) {
    if (net) { var n = net; net = null; n.close(reason); }
  }
  function goOffline(api, msg) {
    mode = 'ai';
    netPhase = 'off';
    netMsg = msg || '';
    if (api) resetRun(api);
  }

  function handlers(api) {
    return {
      onStatus: function (t) { netMsg = t; },
      onOpen: function (role) {
        netPhase = 'live';
        netMsg = '';
        mode = role;
        resetRun(api);
        if (api.forcePlay) api.forcePlay();   // match is live: never sit behind the intro card
        if (!toastOnline) {
          toastOnline = true;
          api.toast('🏓 Online match connected! <span class="xp">+30 XP</span>');
        } else {
          api.toast('🏓 Opponent connected');
        }
      },
      onData: function (m) {
        netSeen = 0;
        if (m.t === 's' && mode === 'guest') {          // authoritative snapshot
          lastState = m;
          oppTargetY = m.hy;
          myScore = m.gs; oppScore = m.hs;
          serving = !!m.sv;
          if (typeof m.rl === 'number') rally = m.rl;
        } else if (m.t === 'p' && mode === 'host') {     // guest paddle input
          oppTargetY = m.y;
        } else if (m.t === 'fx' && mode === 'guest') {   // host-driven effects
          if (m.k === 'hit') { api.spawnParticles(m.x, m.y, api.colors.white, 8); api.buzz(12); }
          else if (m.k === 'point') {
            api.spawnParticles(m.x, m.y, m.me ? api.colors.green : api.colors.accent, 22);
            api.shake(6);
            addFloat(api.W / 2, api.H * 0.33, m.me ? 'YOU SCORE!' : 'THEY SCORE', m.me ? api.colors.green : api.colors.accent, 22);
          }
        } else if (m.t === 'end') {
          netPhase = 'ended';
          netMsg = m.win ? 'YOU LOST THE MATCH' : 'YOU WON THE MATCH';
        }
      },
      onClose: function (reason) {
        if (netPhase === 'live') { netMsg = 'Opponent left — back to AI'; }
        else if (netPhase !== 'ended') { netMsg = reason || 'disconnected'; }
        net = null;
        mode = 'ai';
        netPhase = 'off';
      }
    };
  }

  function startHost(api, fixedRoom) {
    if (!window.NETPLAY || !window.NETPLAY.available) { netMsg = 'WebRTC not supported here'; return; }
    netClose('restart');
    netPhase = 'hosting';
    netMsg = 'creating room…';
    net = window.NETPLAY.create(handlers(api));
    net.host(fixedRoom).then(function (room) {
      netRoom = room;
      netLink = window.NETPLAY.linkFor(room);
      if (navigator.clipboard) navigator.clipboard.writeText(netLink).catch(function () {});
    }).catch(function () {
      netMsg = 'could not create room';
      netPhase = 'off';
      net = null;
    });
  }
  function startJoin(api, room) {
    if (!window.NETPLAY || !window.NETPLAY.available) { netMsg = 'WebRTC not supported here'; return; }
    netClose('restart');
    netPhase = 'joining';
    netRoom = room;
    netMsg = 'joining ' + room + '…';
    net = window.NETPLAY.create(handlers(api));
    net.join(room).catch(function () {
      netMsg = 'room ' + room + ' not found — check the code';
      netPhase = 'code';
      net = null;
    });
  }

  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    window.__pong = {
      state: function () {
        return { mode: mode, phase: netPhase, room: netRoom, link: netLink, msg: netMsg,
                 my: myScore, opp: oppScore, ball: { x: Math.round(ball ? ball.x : 0), y: Math.round(ball ? ball.y : 0) },
                 oppY: Math.round(oppY), serving: !!serving };
      },
      host: function (api, room) { startHost(api, room); },
      join: function (api, room) { startJoin(api, room); },
      raw: function () { return lastState; },
      sendPaddle: function (y) { if (net) net.send({ t: 'p', y: y }); },
      simTick: function (api, dt, w, h) { api.W = w; api.H = h; }
    };
  }

  window.ARCADE.register({
    id: 'pong', name: 'Packet Pong', steer: true, icon: '🏓',
    onlineActive: function () { return netPhase === 'live'; },
    blocksPlay: function () { return netPhase === 'hosting' || netPhase === 'joining' || netPhase === 'code'; },
    hint: 'Move the pointer — return the packet',
    hintTouch: 'Drag up / down anywhere — the paddle follows · or 🧭 Tilt',
    scoreLabel: 'Rally',

    controls: [],

    start: function (api) {
      resetRun(api);
      // auto-join when the page was opened from an invite link
      if (netPhase === 'off' && window.NETPLAY) {
        var room = window.NETPLAY.roomFromUrl();
        if (room && room !== netRoom) startJoin(api, room);
      }
    },

    step: function (dt, api) {
      var L = layout(api);
      var base = baseSpeed(api);
      var maxSp = maxSpeed(api);
      var r = 7;
      var i, f;

      // paddle follows pointer (or keys)
      if (api.pointer.x !== lastPX || api.pointer.y !== lastPY) {
        pointerActive = true; targetY = api.pointer.y;
        lastPX = api.pointer.x; lastPY = api.pointer.y;
      }
      playerY += (clamp(targetY, L.ph / 2, api.H - L.ph / 2) - playerY) * Math.min(1, dt * 16);

      // floats + trail decay run in every mode
      for (i = floats.length - 1; i >= 0; i--) {
        f = floats[i];
        f.life -= dt; f.y += f.vy * dt;
        if (f.life <= 0) floats.splice(i, 1);
      }
      for (i = trail.length - 1; i >= 0; i--) {
        trail[i].life -= dt * 2.6;
        if (trail[i].life <= 0) trail.splice(i, 1);
      }
      if (squash > 0) squash -= dt * 4;

      /* ---------- ONLINE: guest ---------- */
      if (mode === 'guest') {
        netSeen += dt;
        if (netSeen > 6) { netClose('timed out'); goOffline(api, 'connection lost'); return; }
        netSendT += dt;
        if (netSendT >= 0.033) {
          netSendT = 0;
          if (net) net.send({ t: 'p', y: Math.round(playerY) });
        }
        if (lastState) {
          // guest sees the mirrored court: host x -> W - x
          var tx = api.W - lastState.bx * api.W;
          var ty = lastState.by * api.H;
          ballRender.x += (tx - ballRender.x) * Math.min(1, dt * 18);
          ballRender.y += (ty - ballRender.y) * Math.min(1, dt * 18);
          ball.x = ballRender.x; ball.y = ballRender.y;
          if (!serving) {
            trail.push({ x: ball.x, y: ball.y, life: 1 });
            if (trail.length > 14) trail.shift();
          }
        }
        oppY += (clamp(oppTargetY, L.ph / 2, api.H - L.ph / 2) - oppY) * Math.min(1, dt * 12);
        api.setScore(myScore);
        return;
      }

      /* ---------- ONLINE: host (authoritative) or single-player ---------- */
      if (mode === 'host') {
        netSeen += dt;
        if (netSeen > 6) { netClose('timed out'); goOffline(api, 'connection lost'); return; }
        oppY += (clamp(oppTargetY, L.ph / 2, api.H - L.ph / 2) - oppY) * Math.min(1, dt * 12);
      } else {
        if (over) return;
      }
      elapsed += dt;

      if (serving) {
        serveT -= dt;
        ball.x = api.W / 2; ball.y = api.H / 2;
        ballRender.x = ball.x; ballRender.y = ball.y;
        if (serveT <= 0) {
          serving = false;
          speed = base;
          var dir = (mode === 'host' && Math.random() < 0.5) ? 1 : -1;
          var ang = api.rand(-0.35, 0.35);
          ball.vx = dir * speed * Math.cos(ang);
          ball.vy = speed * Math.sin(ang) + api.rand(-40, 40);
        }
      } else {
        ball.x += ball.vx * dt;
        ball.y += ball.vy * dt;
        trail.push({ x: ball.x, y: ball.y, life: 1 });
        if (trail.length > 14) trail.shift();

        if (ball.y < r) { ball.y = r; ball.vy = Math.abs(ball.vy); squash = 1; squashAxis = 1; }
        if (ball.y > api.H - r) { ball.y = api.H - r; ball.vy = -Math.abs(ball.vy); squash = 1; squashAxis = 1; }

        // left paddle = me
        if (ball.vx < 0 && ball.x - r <= L.planeL && ball.x > L.m) {
          if (Math.abs(ball.y - playerY) <= L.ph / 2 + r) {
            ball.x = L.planeL + r;
            var off = (ball.y - playerY) / (L.ph / 2);
            speed = Math.min(maxSp, speed * 1.045 + 8);
            var a2 = off * 0.62;
            ball.vx = Math.abs(speed * Math.cos(a2));
            ball.vy = speed * Math.sin(a2);
            squash = 1; squashAxis = 0;
            api.spawnParticles(ball.x, ball.y, api.colors.accent, 8);
            api.buzz(12);
            rally++;
            if (mode === 'host') {
              if (net) net.send({ t: 'fx', k: 'hit', x: ball.x, y: ball.y });
            } else {
              score++; api.setScore(score);
              if (score === 10 && !toastRally) { toastRally = true; api.toast('🏓 10 rally streak <span class="xp">+15 XP</span>'); }
            }
          }
        }
        // right paddle = AI or remote player
        var rightY = (mode === 'host') ? oppY : aiY;
        if (ball.vx > 0 && ball.x + r >= L.planeR && ball.x < api.W - L.m) {
          if (Math.abs(ball.y - rightY) <= L.ph / 2 + r) {
            ball.x = L.planeR - r;
            var off2 = (ball.y - rightY) / (L.ph / 2);
            speed = Math.min(maxSp, speed * 1.045 + 8);
            var a3 = off2 * 0.62;
            ball.vx = -Math.abs(speed * Math.cos(a3));
            ball.vy = speed * Math.sin(a3);
            squash = 1; squashAxis = 0;
            api.spawnParticles(ball.x, ball.y, api.colors.blue, 8);
            if (mode === 'host' && net) net.send({ t: 'fx', k: 'hit', x: ball.x, y: ball.y });
          }
        }

        // point scored
        if (ball.x < -30) {                       // I missed
          if (mode === 'host') {
            oppScore++;
            api.spawnParticles(20, ball.y, api.colors.accent, 22);
            api.shake(7);
            addFloat(api.W / 2, api.H * 0.33, 'THEY SCORE', api.colors.accent, 22);
            if (net) net.send({ t: 'fx', k: 'point', x: api.W - 20, y: ball.y, me: true });
            serve(1.0);
          } else {
            over = true;
            api.spawnParticles(20, ball.y, api.colors.accent, 26);
            api.shake(8);
            api.gameOver(score, 'CONNECTION LOST');
            return;
          }
        } else if (ball.x > api.W + 30) {         // they missed
          if (mode === 'host') {
            myScore++;
            api.spawnParticles(api.W - 20, ball.y, api.colors.green, 22);
            api.shake(6);
            addFloat(api.W / 2, api.H * 0.33, 'YOU SCORE!', api.colors.green, 22);
            if (net) net.send({ t: 'fx', k: 'point', x: 20, y: ball.y, me: false });
            serve(1.0);
          } else {
            timeouts++;
            score += 10;
            api.setScore(score);
            api.spawnParticles(api.W - 20, ball.y, api.colors.gold, 22);
            api.shake(5);
            addFloat(api.W / 2, api.H * 0.33, 'SERVER TIMEOUT!', api.colors.gold, 24);
            if (!toastTimeout) { toastTimeout = true; api.toast('🏓 SERVER TIMEOUT — first ace <span class="xp">+15 XP</span>'); }
            serve(0.85);
          }
        }
      }

      // AI paddle (single player only)
      if (mode === 'ai') {
        aiReact -= dt;
        if (aiReact <= 0) {
          aiReact = 0.09;
          var err = (1 - Math.min(1, elapsed / 45)) * api.H * 0.16;
          aiTarget = ball.y + api.rand(-err, err);
        }
        var aiSp = (240 + Math.min(220, elapsed * 7)) * dt;
        var d = clamp(aiTarget, L.ph / 2, api.H - L.ph / 2) - aiY;
        aiY += clamp(d, -aiSp, aiSp);
      }

      // host broadcast (normalized coords so both sides scale independently)
      if (mode === 'host') {
        netSendT += dt;
        if (netSendT >= 0.033) {
          netSendT = 0;
          if (net) net.send({
            t: 's',
            bx: ball.x / api.W, by: ball.y / api.H,
            hy: Math.round(playerY),
            hs: myScore, gs: oppScore,
            sv: serving ? 1 : 0, rl: rally
          });
        }
        api.setScore(myScore);
      }
    },

    draw: function (ctx, api) {
      var L = layout(api);
      var online = (mode === 'host' || mode === 'guest');
      var i, f;

      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';

      // court labels
      ctx.font = '800 ' + Math.round(Math.min(44, api.W * 0.075)) + 'px Montserrat, sans-serif';
      ctx.globalAlpha = 0.06;
      ctx.fillStyle = api.colors.white;
      ctx.fillText(online ? 'YOU' : 'CLIENT', api.W * 0.25, api.H * 0.52);
      ctx.fillText(online ? 'RIVAL' : 'SERVER', api.W * 0.75, api.H * 0.52);
      ctx.globalAlpha = 1;

      // center line
      ctx.strokeStyle = api.colors.muted;
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 12]);
      ctx.beginPath();
      ctx.moveTo(api.W / 2, 12);
      ctx.lineTo(api.W / 2, api.H - 12);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // trail
      for (i = 0; i < trail.length; i++) {
        var tr = trail[i];
        var s = 14 * (0.3 + 0.7 * tr.life);
        ctx.globalAlpha = tr.life * 0.25;
        ctx.fillStyle = api.colors.white;
        ctx.fillRect(tr.x - s / 2, tr.y - s / 2, s, s);
      }
      ctx.globalAlpha = 1;

      // packet
      ctx.save();
      ctx.translate(ball.x, ball.y);
      var pulse = serving ? 1 + 0.12 * Math.sin(elapsed * 9) : 1;
      var sx = pulse, sy = pulse;
      if (squash > 0) {
        if (squashAxis === 0) { sx *= 1 - 0.45 * squash; sy *= 1 + 0.45 * squash; }
        else { sx *= 1 + 0.45 * squash; sy *= 1 - 0.45 * squash; }
      }
      ctx.scale(sx, sy);
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur = 16;
      ctx.fillStyle = api.colors.white;
      ctx.fillRect(-7, -7, 14, 14);
      ctx.restore();

      // paddles
      var rightY = online ? oppY : aiY;
      var pr = Math.min(6, L.pw / 2);
      ctx.shadowColor = api.colors.accent;
      ctx.shadowBlur = 12;
      ctx.fillStyle = api.colors.accent;
      api.roundRect(ctx, L.m, playerY - L.ph / 2, L.pw, L.ph, pr);
      ctx.fill();
      ctx.shadowColor = api.colors.blue;
      ctx.fillStyle = api.colors.blue;
      api.roundRect(ctx, L.planeR, rightY - L.ph / 2, L.pw, L.ph, pr);
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.font = '700 9px Montserrat, sans-serif';
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = api.colors.muted;
      ctx.fillText('YOU', L.m + L.pw / 2, clamp(playerY - L.ph / 2 - 9, 8, api.H));
      ctx.fillText(online ? 'RIVAL' : 'AI · sv-01', L.planeR + L.pw / 2, clamp(rightY - L.ph / 2 - 9, 8, api.H));
      ctx.globalAlpha = 1;

      // top readout
      if (online) {
        ctx.font = '800 20px Montserrat, sans-serif';
        ctx.fillStyle = api.colors.white;
        ctx.fillText(myScore + '  —  ' + oppScore, api.W / 2, 26);
        ctx.font = '700 10px Montserrat, sans-serif';
        ctx.fillStyle = api.colors.green;
        ctx.fillText('● ONLINE 1v1 · ' + (mode === 'host' ? 'HOST' : 'GUEST'), api.W / 2, 42);
      } else {
        var ping = serving ? 12 : Math.round(12 + Math.max(0, speed - baseSpeed(api)) * 0.35);
        ctx.font = '700 12px Montserrat, sans-serif';
        ctx.fillStyle = ping > 180 ? api.colors.accent2 : (ping > 80 ? api.colors.gold : api.colors.green);
        ctx.fillText('PING ' + ping + 'ms', api.W / 2, 20);
      }

      // floats
      for (i = 0; i < floats.length; i++) {
        f = floats[i];
        ctx.globalAlpha = Math.min(1, Math.max(0, f.life));
        ctx.font = '800 ' + Math.round(f.size) + 'px Montserrat, sans-serif';
        ctx.fillStyle = f.color;
        ctx.fillText(f.txt, f.x, f.y);
      }
      ctx.globalAlpha = 1;

      // lobby / status panel (game is frozen behind it)
      if (netPhase === 'hosting' || netPhase === 'joining' || netPhase === 'code') {
        var small = api.W < 520;
        ctx.fillStyle = 'rgba(7,10,20,0.94)';
        ctx.fillRect(0, 0, api.W, api.H);
        lobbyBtns = {};

        if (netPhase === 'code') {
          ctx.fillStyle = api.colors.accent;
          ctx.font = '800 ' + (small ? 17 : 22) + 'px Montserrat, sans-serif';
          ctx.fillText('JOIN A MATCH', api.W / 2, api.H * 0.2);
          ctx.fillStyle = api.colors.muted;
          ctx.font = '600 ' + (small ? 11 : 13) + 'px Poppins, Montserrat, sans-serif';
          ctx.fillText('Type or tap in the 4-character room code', api.W / 2, api.H * 0.2 + (small ? 20 : 26));

          var sw = Math.min(58, api.W * 0.15), gap = Math.min(14, api.W * 0.03);
          var tot = sw * 4 + gap * 3, x0 = (api.W - tot) / 2, cy = api.H * 0.52;
          lobbyBtns.slots = [];
          for (var ci = 0; ci < 4; ci++) {
            var sx2 = x0 + ci * (sw + gap), sy2 = cy - sw * 0.6, sh2 = sw * 1.2;
            lobbyBtns.slots.push({ x: sx2, y: sy2, w: sw, h: sh2 });
            var on2 = ci === codeSlot;
            ctx.fillStyle = on2 ? 'rgba(249,0,77,0.14)' : 'rgba(255,255,255,0.05)';
            api.roundRect(ctx, sx2, sy2, sw, sh2, 9); ctx.fill();
            ctx.strokeStyle = on2 ? api.colors.accent : 'rgba(255,255,255,0.25)';
            ctx.lineWidth = on2 ? 2.5 : 1.5;
            api.roundRect(ctx, sx2, sy2, sw, sh2, 9); ctx.stroke();
            ctx.fillStyle = api.colors.white;
            ctx.font = '800 ' + Math.round(sw * 0.58) + 'px Montserrat, sans-serif';
            ctx.fillText(codeSlots[ci], sx2 + sw / 2, sy2 + sh2 / 2 + sw * 0.2);
            ctx.fillStyle = on2 ? api.colors.accent : api.colors.muted;
            ctx.font = '700 13px Montserrat, sans-serif';
            ctx.fillText('▲', sx2 + sw / 2, sy2 - 10);
            ctx.fillText('▼', sx2 + sw / 2, sy2 + sh2 + 21);
          }
          var jb = { x: api.W / 2 - Math.min(180, api.W * 0.4) / 2, y: api.H - (small ? 62 : 76), w: Math.min(180, api.W * 0.4), h: small ? 38 : 44 };
          lobbyBtns.join = jb;
          var jg = ctx.createLinearGradient(jb.x, 0, jb.x + jb.w, 0);
          jg.addColorStop(0, '#ff3d71'); jg.addColorStop(1, '#f9004d');
          ctx.fillStyle = jg;
          api.roundRect(ctx, jb.x, jb.y, jb.w, jb.h, jb.h / 2); ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.font = '800 14px Montserrat, sans-serif';
          ctx.fillText('JOIN MATCH', jb.x + jb.w / 2, jb.y + jb.h / 2 + 5);
          if (netMsg) {
            ctx.fillStyle = api.colors.accent2;
            ctx.font = '700 12px Montserrat, sans-serif';
            ctx.fillText(netMsg, api.W / 2, jb.y - 12);
          }
        } else if (netPhase === 'hosting') {
          ctx.fillStyle = api.colors.accent;
          ctx.font = '800 ' + (small ? 16 : 21) + 'px Montserrat, sans-serif';
          ctx.fillText('MATCH ROOM READY', api.W / 2, api.H * 0.16);
          ctx.fillStyle = api.colors.muted;
          ctx.font = '600 ' + (small ? 11 : 13) + 'px Poppins, Montserrat, sans-serif';
          ctx.fillText('Your friend opens the site and taps "Join a code"', api.W / 2, api.H * 0.16 + (small ? 19 : 24));

          ctx.fillStyle = api.colors.white;
          ctx.font = '800 ' + Math.round(Math.min(76, api.W * 0.17)) + 'px Montserrat, sans-serif';
          ctx.fillText(netRoom || '····', api.W / 2, api.H * 0.47);

          var cb = { x: api.W / 2 - Math.min(210, api.W * 0.5) / 2, y: api.H * 0.58, w: Math.min(210, api.W * 0.5), h: small ? 34 : 40 };
          lobbyBtns.copy = cb;
          var copied = copiedT > performance.now();
          ctx.fillStyle = copied ? 'rgba(43,214,123,0.18)' : 'rgba(255,255,255,0.06)';
          api.roundRect(ctx, cb.x, cb.y, cb.w, cb.h, cb.h / 2); ctx.fill();
          ctx.strokeStyle = copied ? api.colors.green : 'rgba(255,255,255,0.25)';
          ctx.lineWidth = 1.5;
          api.roundRect(ctx, cb.x, cb.y, cb.w, cb.h, cb.h / 2); ctx.stroke();
          ctx.fillStyle = copied ? api.colors.green : api.colors.white;
          ctx.font = '700 12px Montserrat, sans-serif';
          ctx.fillText(copied ? '✓ LINK COPIED' : '🔗 COPY INVITE LINK', cb.x + cb.w / 2, cb.y + cb.h / 2 + 4);

          var dots = 1 + (Math.floor(performance.now() / 400) % 3);
          ctx.fillStyle = api.colors.gold;
          ctx.font = '700 ' + (small ? 12 : 14) + 'px Montserrat, sans-serif';
          ctx.fillText('waiting for player 2' + new Array(dots + 1).join('.'), api.W / 2, api.H * 0.75);
          ctx.fillStyle = api.colors.muted;
          ctx.font = '600 11px Poppins, Montserrat, sans-serif';
          ctx.fillText('Game is paused until they join · Cancel in the bar below', api.W / 2, api.H * 0.75 + 22);
        } else {
          ctx.fillStyle = api.colors.accent;
          ctx.font = '800 ' + (small ? 17 : 22) + 'px Montserrat, sans-serif';
          ctx.fillText('CONNECTING…', api.W / 2, api.H * 0.44);
          ctx.fillStyle = api.colors.muted;
          ctx.font = '700 13px Montserrat, sans-serif';
          ctx.fillText(netMsg || 'joining ' + netRoom, api.W / 2, api.H * 0.44 + 26);
        }
      } else if (netMsg && netPhase === 'off') {
        ctx.fillStyle = api.colors.muted;
        ctx.font = '700 12px Montserrat, sans-serif';
        ctx.fillText(netMsg, api.W / 2, api.H - 14);
      }

      ctx.restore();
    },

    pointerDown: function (p, api) {
      if (netPhase === 'hosting' || netPhase === 'code') {
        var B = lobbyBtns || {};
        if (netPhase === 'hosting' && hit(B.copy, p)) {
          if (navigator.clipboard && netLink) navigator.clipboard.writeText(netLink).catch(function () {});
          copiedT = performance.now() + 1600;
          api.buzz(15);
          return;
        }
        if (netPhase === 'code') {
          if (hit(B.join, p)) { tryJoinCode(api); return; }
          var sl = B.slots || [];
          for (var i = 0; i < sl.length; i++) {
            var b = sl[i];
            if (p.x >= b.x - 6 && p.x <= b.x + b.w + 6) {
              if (p.y >= b.y - 32 && p.y < b.y) { codeSlot = i; bumpCode(i, 1); api.buzz(8); return; }
              if (p.y > b.y + b.h && p.y <= b.y + b.h + 32) { codeSlot = i; bumpCode(i, -1); api.buzz(8); return; }
              if (p.y >= b.y && p.y <= b.y + b.h) { codeSlot = i; return; }
            }
          }
        }
        return;
      }
      pointerActive = true; targetY = p.y; lastPX = p.x; lastPY = p.y;
    },
    pointerMove: function (p, api) {
      if (netPhase !== 'off' && netPhase !== 'live') return;
      pointerActive = true; targetY = p.y; lastPX = p.x; lastPY = p.y;
    },
    keyDown: function (key, api) {
      if (netPhase === 'code') {
        if (/^[a-zA-Z0-9]$/.test(key)) {
          codeSlots[codeSlot] = key.toUpperCase();
          codeSlot = Math.min(3, codeSlot + 1);
        } else if (key === 'Backspace' || key === 'ArrowLeft') {
          codeSlot = Math.max(0, codeSlot - 1);
        } else if (key === 'ArrowRight') {
          codeSlot = Math.min(3, codeSlot + 1);
        } else if (key === 'ArrowUp') { bumpCode(codeSlot, 1); }
        else if (key === 'ArrowDown') { bumpCode(codeSlot, -1); }
        else if (key === 'Enter') { tryJoinCode(api); }
        return;
      }
      if (netPhase === 'hosting' || netPhase === 'joining') return;
      if (key === 'ArrowUp' || key === 'w' || key === 'W') { pointerActive = false; targetY -= 52; }
      else if (key === 'ArrowDown' || key === 's' || key === 'S') { pointerActive = false; targetY += 52; }
    }
  });
})();

/* ============================================================
   Game 10: Spam Blaster
   ============================================================ */
(function () { 'use strict';

  var S = null;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function rowColor(r, api) {
    var cs = [api.colors.accent2, api.colors.blue, api.colors.green];
    return cs[r % 3];
  }

  function layout(api) {
    var cfg = S.cfg;
    var sx = Math.min(48, Math.max(28, (api.W - 50) / cfg.cols));
    var sy = sx * 0.88;
    var gw = (cfg.cols - 1) * sx;
    var amp = Math.max(6, (api.W - gw) / 2 - 30);
    var cx = api.W / 2 + Math.sin(S.phase) * amp;
    var br = clamp(sx * 0.34, 9, 15);
    return { sx: sx, sy: sy, gw: gw, cx: cx, br: br };
  }

  function botXY(b, L) {
    return {
      x: L.cx - L.gw / 2 + b.c * L.sx,
      y: S.cfg.startY + b.r * L.sy + S.stepOffset + Math.sin(S.t * 2.6 + b.bp) * 2.5
    };
  }

  function addFloat(x, y, text, color, size) {
    S.floats.push({ x: x, y: y, text: text, color: color, size: size || 12, life: 0.8, max: 0.8 });
    if (S.floats.length > 24) S.floats.shift();
  }

  function startWave(n, api) {
    S.wave = n;
    var baseCols = clamp(Math.floor((api.W - 60) / 46), 4, 8);
    var cols = clamp(baseCols + Math.floor((n - 1) / 3), 4, 10);
    var rows = Math.min(3 + Math.floor((n - 1) / 2), 5);
    S.cfg = {
      cols: cols, rows: rows,
      swayFreq: 0.7 + n * 0.09,
      stepInterval: Math.max(2.6, 5.4 - n * 0.4),
      startY: Math.min(58 + n * 6, 110),
      mailMin: Math.max(0.65, 2.3 - n * 0.18),
      mailMax: Math.max(1.4, 3.4 - n * 0.2),
      mailSpeed: Math.min(200, 90 + n * 9)
    };
    S.bots = [];
    for (var r = 0; r < rows; r++)
      for (var c = 0; c < cols; c++)
        S.bots.push({ c: c, r: r, alive: true, bp: api.rand(0, 6.283) });
    S.aliveN = S.bots.length;
    S.total = S.bots.length;
    S.phase = api.rand(0, 6.283);
    S.stepOffset = 0;
    S.stepTimer = 0;
    S.mailTimer = api.rand(1.6, 2.6);
    S.banner = { text: 'WAVE ' + n, sub: (n === 1 ? 'DELETE THE SPAM' : ''), subColor: api.colors.accent2, t: 0, dur: 1.3 };
  }

  function die(api, x, y) {
    if (S.over) return;
    S.over = true;
    api.spawnParticles(x, y, api.colors.accent, 36);
    api.spawnParticles(x, y, api.colors.gold, 18);
    api.shake(9);
    api.gameOver(S.score, 'INBOX OVERRUN');
  }

  window.ARCADE.register({
    id: 'blaster', name: 'Spam Blaster', steer: true, icon: '👾',
    hint: 'Move the pointer — auto-fire, clear the spam waves',
    hintTouch: 'Drag to strafe — auto-fire is on · or 🧭 Tilt',

    start: function (api) {
      S = {
        t: 0, score: 0, over: false,
        tx: api.W / 2,
        lastPX: api.pointer ? api.pointer.x : api.W / 2,
        ship: { x: api.W / 2, vx: 0 },
        bullets: [], mails: [], floats: [],
        wave: 1, bots: [], aliveN: 0, total: 0,
        phase: 0, stepOffset: 0, stepTimer: 0,
        breather: 0,
        fireTimer: 0.35, muzzle: 0,
        mailTimer: 2.5,
        gold: null, goldT: api.rand(7, 12),
        banner: null,
        chain: 0, chainT: 0,
        toastWave: false, toastGold: false,
        cfg: null
      };
      startWave(1, api);
      api.setScore(0);
    },

    step: function (dt, api) {
      if (!S || S.over) return;
      S.t += dt;
      var shipY = api.H - 44;
      var deathY = shipY - 18;
      var i, j, b, m;

      // ship follows pointer (keyboard nudges kept until pointer moves again)
      if (api.pointer.x !== S.lastPX) { S.tx = api.pointer.x; S.lastPX = api.pointer.x; }
      var prev = S.ship.x;
      S.ship.x += (clamp(S.tx, 16, api.W - 16) - S.ship.x) * Math.min(1, dt * 14);
      S.ship.vx = (S.ship.x - prev) / (dt || 0.016);

      // auto-fire ~6/s
      S.fireTimer -= dt;
      if (S.fireTimer <= 0) {
        S.fireTimer += 0.167;
        S.bullets.push({ x: S.ship.x, y: shipY - 20 });
        S.muzzle = 0.06;
      }
      S.muzzle -= dt;

      for (i = S.bullets.length - 1; i >= 0; i--) {
        S.bullets[i].y -= 560 * dt;
        if (S.bullets[i].y < -24) S.bullets.splice(i, 1);
      }

      if (S.chainT > 0) { S.chainT -= dt; if (S.chainT <= 0) S.chain = 0; }

      if (S.aliveN > 0) {
        // formation speeds up as it thins out (classic invaders panic)
        var mul = 1 + (1 - S.aliveN / S.total) * 0.8;
        S.phase += S.cfg.swayFreq * mul * dt;
        S.stepTimer += dt * mul;
        if (S.stepTimer >= S.cfg.stepInterval) { S.stepTimer = 0; S.stepOffset += 15; }
        var L = layout(api);

        // bullets vs bots
        for (i = S.bullets.length - 1; i >= 0; i--) {
          var bl = S.bullets[i], hit = false;
          for (j = 0; j < S.bots.length; j++) {
            b = S.bots[j];
            if (!b.alive) continue;
            var p = botXY(b, L);
            var dx = bl.x - p.x, dy = bl.y - p.y;
            if (dx * dx + dy * dy < (L.br + 6) * (L.br + 6)) {
              b.alive = false; S.aliveN--; hit = true;
              api.spawnParticles(p.x, p.y, rowColor(b.r, api), 10);
              S.score++; api.setScore(S.score);
              addFloat(p.x, p.y - 8, '+1', api.colors.white, 11);
              S.chain++; S.chainT = 0.9;
              if (S.chain % 6 === 0) {
                S.score += 2; api.setScore(S.score);
                addFloat(p.x, p.y - 26, 'CHAIN x' + S.chain + '  +2', api.colors.gold, 15);
                api.shake(4);
              }
              break;
            }
          }
          if (hit) S.bullets.splice(i, 1);
        }

        // bots reaching the firewall
        for (j = 0; j < S.bots.length; j++) {
          b = S.bots[j];
          if (!b.alive) continue;
          var p2 = botXY(b, L);
          if (p2.y + L.br >= deathY) { die(api, S.ship.x, shipY); return; }
        }

        // a bottom-row bot mails you
        S.mailTimer -= dt;
        if (S.mailTimer <= 0) {
          S.mailTimer = api.rand(S.cfg.mailMin, S.cfg.mailMax);
          var bottoms = {}, list = [], k;
          for (j = 0; j < S.bots.length; j++) {
            b = S.bots[j];
            if (!b.alive) continue;
            if (bottoms[b.c] === undefined || b.r > bottoms[b.c].r) bottoms[b.c] = b;
          }
          for (k in bottoms) list.push(bottoms[k]);
          if (list.length) {
            var shooter = list[Math.floor(api.rand(0, list.length))];
            var sp = botXY(shooter, L);
            S.mails.push({ x: sp.x, y: sp.y + L.br + 4, vy: S.cfg.mailSpeed, wob: api.rand(0, 6.283) });
          }
        }

        // wave cleared
        if (S.aliveN === 0) {
          S.score += 10; api.setScore(S.score);
          S.breather = 1.4;
          S.banner = { text: 'WAVE ' + S.wave + ' CLEARED', sub: '+10', subColor: api.colors.green, t: 0, dur: 1.3 };
          api.spawnParticles(api.W / 2, api.H * 0.35, api.colors.green, 18);
          if (!S.toastWave) { S.toastWave = true; api.toast('🏆 First wave deleted <span class="xp">+15 XP</span>'); }
          S.bots = [];
        }
      } else if (S.breather > 0) {
        S.breather -= dt;
        if (S.breather <= 0) startWave(S.wave + 1, api);
      }

      // golden UNSUBSCRIBE bot
      if (S.gold) {
        S.gold.x += S.gold.dir * S.gold.sp * dt;
        if (S.gold.x < -120 || S.gold.x > api.W + 120) {
          S.gold = null; S.goldT = api.rand(9, 16);
        } else {
          for (i = S.bullets.length - 1; i >= 0; i--) {
            var gx = S.bullets[i].x - S.gold.x, gy = S.bullets[i].y - S.gold.y;
            if (gx * gx + gy * gy < 400) {
              S.bullets.splice(i, 1);
              S.score += 5; api.setScore(S.score);
              api.spawnParticles(S.gold.x, S.gold.y, api.colors.gold, 26);
              addFloat(S.gold.x, Math.max(24, S.gold.y - 4), 'UNSUBSCRIBED  +5', api.colors.gold, 15);
              api.shake(6);
              for (j = 0; j < S.mails.length; j++) api.spawnParticles(S.mails[j].x, S.mails[j].y, api.colors.gold, 6);
              S.mails.length = 0;
              if (!S.toastGold) { S.toastGold = true; api.toast('🏆 Unsubscribed from everything <span class="xp">+20 XP</span>'); }
              S.gold = null; S.goldT = api.rand(14, 22);
              break;
            }
          }
        }
      } else {
        S.goldT -= dt;
        if (S.goldT <= 0) {
          var dir = api.rand(0, 1) < 0.5 ? 1 : -1;
          S.gold = { x: dir === 1 ? -60 : api.W + 60, y: 26, dir: dir, sp: 120 + S.wave * 8 };
        }
      }

      // spam mail
      for (i = S.mails.length - 1; i >= 0; i--) {
        m = S.mails[i];
        m.y += m.vy * dt;
        var mdx = m.x - S.ship.x, mdy = m.y - shipY;
        if (mdx > -18 && mdx < 18 && mdy > -20 && mdy < 14) { die(api, S.ship.x, shipY); return; }
        if (m.y > api.H + 24) S.mails.splice(i, 1);
      }

      // floating text
      for (i = S.floats.length - 1; i >= 0; i--) {
        S.floats[i].y -= 34 * dt;
        S.floats[i].life -= dt;
        if (S.floats[i].life <= 0) S.floats.splice(i, 1);
      }

      if (S.banner) { S.banner.t += dt; if (S.banner.t >= S.banner.dur) S.banner = null; }
    },

    draw: function (ctx, api) {
      if (!S) return;
      var c = api.colors;
      var shipY = api.H - 44, deathY = shipY - 18;
      var i, m;

      // firewall line
      ctx.globalAlpha = 0.14;
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 9]);
      ctx.beginPath(); ctx.moveTo(0, deathY); ctx.lineTo(api.W, deathY); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = c.muted;
      ctx.font = '600 9px Montserrat, sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillText('FIREWALL', 8, deathY - 5);

      // wave tag
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = c.muted;
      ctx.textAlign = 'right';
      ctx.font = '700 11px Montserrat, sans-serif';
      ctx.fillText('WAVE ' + S.wave, api.W - 10, 18);
      ctx.globalAlpha = 1;

      // bullets
      ctx.fillStyle = c.accent;
      ctx.shadowColor = c.accent; ctx.shadowBlur = 8;
      for (i = 0; i < S.bullets.length; i++) {
        api.roundRect(ctx, S.bullets[i].x - 2, S.bullets[i].y - 8, 4, 14, 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;

      // muzzle flash
      if (S.muzzle > 0) {
        ctx.globalAlpha = 0.8;
        ctx.fillStyle = c.accent2;
        ctx.beginPath(); ctx.arc(S.ship.x, shipY - 22, 5, 0, 6.283); ctx.fill();
        ctx.globalAlpha = 1;
      }

      // spam mail envelopes
      for (i = 0; i < S.mails.length; i++) {
        m = S.mails[i];
        ctx.save();
        ctx.translate(m.x + Math.sin(S.t * 5 + m.wob) * 3, m.y);
        ctx.rotate(Math.sin(S.t * 4 + m.wob) * 0.12);
        ctx.shadowColor = c.accent2; ctx.shadowBlur = 7;
        ctx.fillStyle = c.accent2;
        api.roundRect(ctx, -10, -7, 20, 14, 3); ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(11,17,32,0.7)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(-9, -6); ctx.lineTo(0, 2); ctx.lineTo(9, -6); ctx.stroke();
        ctx.restore();
      }

      // spam bots
      if (S.aliveN > 0) {
        var L = layout(api);
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (i = 0; i < S.bots.length; i++) {
          var b = S.bots[i];
          if (!b.alive) continue;
          var p = botXY(b, L), r0 = L.br;
          var col = rowColor(b.r, api);
          ctx.strokeStyle = col; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(p.x, p.y - r0 * 0.8); ctx.lineTo(p.x, p.y - r0 * 1.5); ctx.stroke();
          ctx.fillStyle = col;
          ctx.beginPath(); ctx.arc(p.x, p.y - r0 * 1.5, 2.2, 0, 6.283); ctx.fill();
          api.roundRect(ctx, p.x - r0, p.y - r0 * 0.85, r0 * 2, r0 * 1.7, r0 * 0.75);
          ctx.fill();
          ctx.fillStyle = c.ink;
          ctx.font = '800 ' + Math.round(r0 * 1.05) + 'px Montserrat, sans-serif';
          ctx.fillText('@', p.x, p.y + 1);
        }
      }

      // golden UNSUBSCRIBE bot with towed banner
      if (S.gold) {
        var g = S.gold;
        var flagX = g.dir === 1 ? g.x - 14 - 70 - 12 : g.x + 14 + 12;
        ctx.globalAlpha = 0.95;
        ctx.strokeStyle = c.gold; ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(g.x - g.dir * 14, g.y);
        ctx.lineTo(g.dir === 1 ? flagX + 70 : flagX, g.y);
        ctx.stroke();
        ctx.fillStyle = c.gold;
        api.roundRect(ctx, flagX, g.y - 8, 70, 16, 4); ctx.fill();
        ctx.fillStyle = c.ink;
        ctx.font = '800 8px Montserrat, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('UNSUBSCRIBE', flagX + 35, g.y + 1);
        ctx.shadowColor = c.gold; ctx.shadowBlur = 12;
        ctx.fillStyle = c.gold;
        api.roundRect(ctx, g.x - 14, g.y - 12, 28, 24, 10); ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = c.ink;
        ctx.font = '800 14px Montserrat, sans-serif';
        ctx.fillText('@', g.x, g.y + 1);
        ctx.globalAlpha = 1;
      }

      // ship (cursor arrow)
      ctx.save();
      ctx.translate(S.ship.x, shipY);
      ctx.rotate(clamp(S.ship.vx * 0.0004, -0.3, 0.3));
      ctx.globalAlpha = 0.5 + Math.sin(S.t * 30) * 0.2;
      ctx.fillStyle = c.accent2;
      ctx.beginPath(); ctx.ellipse(0, 15, 4, 8 + Math.sin(S.t * 25) * 2, 0, 0, 6.283); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.shadowColor = c.accent; ctx.shadowBlur = 12;
      ctx.fillStyle = c.white;
      ctx.strokeStyle = c.accent; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -18); ctx.lineTo(11, 12); ctx.lineTo(0, 5); ctx.lineTo(-11, 12);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.restore();

      // floating text
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (i = 0; i < S.floats.length; i++) {
        var f = S.floats[i];
        ctx.globalAlpha = clamp(f.life / f.max, 0, 1);
        ctx.fillStyle = f.color;
        ctx.font = '800 ' + f.size + 'px Montserrat, sans-serif';
        ctx.fillText(f.text, f.x, f.y);
      }
      ctx.globalAlpha = 1;

      // wave banner
      if (S.banner) {
        var bt = S.banner.t, dur = S.banner.dur;
        var a = Math.min(1, bt * 6) * clamp((dur - bt) * 3, 0, 1);
        var pop = 1 + Math.max(0, 0.25 - bt) * 1.2;
        var fs = Math.round(Math.min(api.W * 0.07, 30) * pop);
        ctx.globalAlpha = clamp(a, 0, 1);
        ctx.fillStyle = c.white;
        ctx.shadowColor = c.accent; ctx.shadowBlur = 16;
        ctx.font = '800 ' + fs + 'px Montserrat, sans-serif';
        ctx.fillText(S.banner.text, api.W / 2, api.H * 0.38);
        if (S.banner.sub) {
          ctx.fillStyle = S.banner.subColor;
          ctx.font = '800 ' + Math.round(fs * 0.6) + 'px Montserrat, sans-serif';
          ctx.fillText(S.banner.sub, api.W / 2, api.H * 0.38 + fs * 0.95);
        }
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
      }

      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.font = '600 12px Montserrat, sans-serif';
      ctx.lineWidth = 1;
    },

    pointerDown: function (p, api) { if (S) S.tx = p.x; },
    pointerMove: function (p, api) { if (S) S.tx = p.x; },
    pointerUp: function (p, api) {},

    keyDown: function (key, api) {
      if (!S || S.over) return;
      if (key === 'ArrowLeft' || key === 'a' || key === 'A') S.tx = clamp(S.tx - 46, 16, api.W - 16);
      else if (key === 'ArrowRight' || key === 'd' || key === 'D') S.tx = clamp(S.tx + 46, 16, api.W - 16);
    }
  });
})();
