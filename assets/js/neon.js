/* ============================================================
   The Neon Room — a physics toy for Aman Yadav's portfolio
   ------------------------------------------------------------
   A neon "OPEN" sign hangs on two chains (Verlet rigid body on
   slack-able ropes), a rocker switch powers it, a slingshot can
   shatter the tubes one by one. The sign is the only light in the
   room: it lights the headline underneath. Canvas 2D + WebAudio,
   hand-written, zero libraries.
   ============================================================ */
(function () {
    'use strict';

    var canvas = document.getElementById('room');
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext('2d');
    var root = document.documentElement;
    var TAU = Math.PI * 2;
    var mq = function (q) { return !!(window.matchMedia && window.matchMedia(q).matches); };
    var reduceMotion = mq('(prefers-reduced-motion: reduce)');
    var coarse = mq('(pointer: coarse)');
    var MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

    var $ = function (id) { return document.getElementById(id); };
    var ui = {
        state: $('state'), shots: $('shots'), tubes: $('tubes'), sound: $('sound'),
        fix: $('fix'), scene: $('scene'), clock: $('clock'), toast: $('toast')
    };

    /* ---------- tunables ---------- */
    var STEP = 1 / 120;      // physics step (s)
    var G = 1450;            // gravity, px/s²
    var DAMP = 0.997;        // per-step velocity retention (air)
    var ITER = 7;            // constraint iterations per step
    var POWER = 14;          // launch speed: px/s per px of pull
    var KICK = 1.35;         // how hard a pebble shoves the sign

    var PINK = { glow: '#f9004d', mid: '#ff5c8d', core: '#ffe6ee', rgb: '255,60,120' };
    var BLUE = { glow: '#1d9bff', mid: '#7fd6ff', core: '#eefbff', rgb: '70,170,255' };
    var LETTER_COUNT = 4;    // O P E N — the border tube is decorative

    /* ---------- state ---------- */
    var W = 0, H = 0, dpr = 1, mobile = false;
    var power = false, shots = 0, brokenCount = 0, soundOn = true;
    var lit = 0, litShown = -1, pinkLight = 0, blueLight = 0;
    var shake = 0, lastT = 0, acc = 0, time = 0;
    var seenFirstBreak = false, seenTrick = false;

    var sign = { w: 0, h: 0, pad: 0, tubeW: 4, pts: [], rods: [], chains: [], drag: null };
    var tubes = [];
    var layer = document.createElement('canvas');
    var lctx = layer.getContext('2d');
    var layerDirty = true, layerI = [];

    var sw = { x: 0, y: 0, w: 0, h: 0, anim: 0, knock: 0, knockV: 0 };
    var sling = { x: 0, y: 0, top: 0, spread: 0, restX: 0, restY: 0, r: 6, maxPull: 120, aim: null, ready: true, respawn: 0, pop: 0, wobble: 0 };
    var pebbles = [], particles = [];
    var pointer = { x: -1, y: -1, id: null, mode: null };
    var hoverSign = false, hoverTube = null;   // pointer resting on (or holding) the sign

    /* ---------- helpers ---------- */
    function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
    function rand(a, b) { return a + Math.random() * (b - a); }
    function roundRect(c, x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        c.beginPath();
        c.moveTo(x + r, y);
        c.arcTo(x + w, y, x + w, y + h, r);
        c.arcTo(x + w, y + h, x, y + h, r);
        c.arcTo(x, y + h, x, y, r);
        c.arcTo(x, y, x + w, y, r);
        c.closePath();
    }
    function arcPts(cx, cy, rx, ry, a0, a1, n) {
        var out = [];
        for (var i = 0; i <= n; i++) {
            var a = a0 + (a1 - a0) * i / n;
            out.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
        }
        return out;
    }
    function roundRectPoly(x, y, w, h, r) {
        var q = Math.PI / 2, n = 7;
        var pts = [];
        pts = pts.concat(arcPts(x + w - r, y + r, r, r, -q, 0, n));
        pts = pts.concat(arcPts(x + w - r, y + h - r, r, r, 0, q, n));
        pts = pts.concat(arcPts(x + r, y + h - r, r, r, q, 2 * q, n));
        pts = pts.concat(arcPts(x + r, y + r, r, r, 2 * q, 3 * q, n));
        pts.push({ x: pts[0].x, y: pts[0].y });
        return pts;
    }

    /* single-stroke neon letters in a 0.7 × 1 box (y down) */
    var LETTER = {
        O: [arcPts(0.35, 0.5, 0.29, 0.45, 0, TAU, 40)],
        P: [[{ x: 0.06, y: 1 }, { x: 0.06, y: 0 }].concat(arcPts(0.40, 0.25, 0.25, 0.25, -Math.PI / 2, Math.PI / 2, 16)).concat([{ x: 0.06, y: 0.5 }])],
        E: [[{ x: 0.62, y: 0 }, { x: 0.06, y: 0 }, { x: 0.06, y: 1 }, { x: 0.62, y: 1 }], [{ x: 0.06, y: 0.5 }, { x: 0.5, y: 0.5 }]],
        N: [[{ x: 0.06, y: 1 }, { x: 0.06, y: 0 }, { x: 0.62, y: 1 }, { x: 0.62, y: 0 }]]
    };
    function scalePolys(polys, ox, oy, s) {
        return polys.map(function (poly) {
            return poly.map(function (p) { return { x: ox + p.x * s, y: oy + p.y * s }; });
        });
    }
    function makeTube(polys, c) {
        return { polys: polys, c: c, I: 0, broken: false, crack: null, flick: null, blink: 0 };
    }

    /* ---------- layout ---------- */
    function layout() {
        W = window.innerWidth; H = window.innerHeight;
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        mobile = W < 700;
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        canvas.style.width = W + 'px';
        canvas.style.height = H + 'px';

        /* sign body — 4 Verlet corners, 6 rods (edges + diagonals) */
        var w = clamp(W * (mobile ? 0.8 : 0.42), 250, 560);
        w = Math.max(200, Math.min(w, H * 0.72));   // never taller than ~30% of the room
        var h = w / 2.4;
        var top = H * (mobile ? 0.15 : 0.14);
        var x0 = W * 0.5 - w / 2;
        var P = function (x, y) { return { x: x, y: y, px: x, py: y }; };
        sign.w = w; sign.h = h;
        sign.pts = [P(x0, top), P(x0 + w, top), P(x0 + w, top + h), P(x0, top + h)];
        var d = Math.sqrt(w * w + h * h);
        sign.rods = [[0, 1, w], [1, 2, h], [2, 3, w], [3, 0, h], [0, 2, d], [1, 3, d]];
        /* chains converge a little toward the ceiling so the sign tilts when it swings */
        var inset = w * 0.12;
        var mk = function (ax, p) {
            var dx = sign.pts[p].x - ax, dy = sign.pts[p].y + 6;
            return { ax: ax, ay: -6, p: p, L: Math.sqrt(dx * dx + dy * dy), slack: false, cool: 0 };
        };
        sign.chains = [mk(x0 + inset, 0), mk(x0 + w - inset, 1)];
        /* tiny initial sway so it feels alive */
        sign.pts.forEach(function (p) { p.px -= 0.9; });

        /* tubes (local coords) */
        var lh = h * 0.5, ly = (h - lh) / 2;
        var adv = 0.94 * lh, tw = 3 * adv + 0.7 * lh, lx = (w - tw) / 2;
        var was = tubes.map(function (t) { return t.broken; });
        var letters = [LETTER.O, LETTER.P, LETTER.E, LETTER.N];
        tubes = letters.map(function (L, i) { return makeTube(scalePolys(L, lx + i * adv, ly, lh), PINK); });
        var bi = h * 0.11;
        tubes.push(makeTube([roundRectPoly(bi, bi, w - 2 * bi, h - 2 * bi, h * 0.16)], BLUE));
        tubes.forEach(function (t, i) { if (was[i]) { t.broken = true; t.crack = { x: t.polys[0][0].x, y: t.polys[0][0].y, seed: 0.5 }; } });
        tubes.forEach(function (t) { if (power && !t.broken) t.I = 1; });
        sign.tubeW = Math.max(3, lh * 0.085);
        sign.pad = h * 0.8;
        layerDirty = true;
        layerI = [];

        /* switch on the right wall */
        sw.w = mobile ? 44 : 58;
        sw.h = sw.w * 1.55;
        sw.x = W - (mobile ? 36 : 96) - sw.w / 2;
        sw.y = H * (mobile ? 0.45 : 0.42);
        sw.anim = power ? 1 : 0;

        /* slingshot, bottom-left */
        sling.x = mobile ? 54 : 118;
        sling.y = H + 6;
        sling.top = sling.y - (mobile ? 118 : 150);
        sling.spread = mobile ? 24 : 30;
        sling.restX = sling.x;
        sling.restY = sling.top + 4;
        sling.r = mobile ? 7 : 6;
        sling.maxPull = mobile ? 96 : 122;
        sling.aim = null;
    }

    /* ---------- sign frame math ---------- */
    function frameAxes() {
        var tl = sign.pts[0], tr = sign.pts[1];
        var dx = tr.x - tl.x, dy = tr.y - tl.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
        return { ox: tl.x, oy: tl.y, ux: dx / len, uy: dy / len };
    }
    function worldToLocal(x, y) {
        var f = frameAxes(), dx = x - f.ox, dy = y - f.oy;
        return { x: dx * f.ux + dy * f.uy, y: -dx * f.uy + dy * f.ux };
    }
    function localToWorld(u, v) {
        var p = sign.pts;
        return {
            x: p[0].x + (p[1].x - p[0].x) * u + (p[3].x - p[0].x) * v,
            y: p[0].y + (p[1].y - p[0].y) * u + (p[3].y - p[0].y) * v
        };
    }
    function shoveSign(u, v, dx, dy) {
        var w = [(1 - u) * (1 - v), u * (1 - v), u * v, (1 - u) * v];
        for (var i = 0; i < 4; i++) { sign.pts[i].x += dx * w[i]; sign.pts[i].y += dy * w[i]; }
    }
    function segDist(px, py, ax, ay, bx, by) {
        var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        var t = l2 ? clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1) : 0;
        var x = ax + dx * t - px, y = ay + dy * t - py;
        return Math.sqrt(x * x + y * y);
    }
    function tubeAt(lx, ly, r) {
        var reach = sign.tubeW * 0.9 + r;
        for (var i = 0; i < LETTER_COUNT; i++) {
            var polys = tubes[i].polys;
            for (var j = 0; j < polys.length; j++) {
                var poly = polys[j];
                for (var k = 0; k < poly.length - 1; k++) {
                    if (segDist(lx, ly, poly[k].x, poly[k].y, poly[k + 1].x, poly[k + 1].y) < reach) return tubes[i];
                }
            }
        }
        return null;
    }

    /* ---------- sound (all synthesized) ---------- */
    var sfx = (function () {
        var ac = null, master = null, humGain = null, buzzGain = null, noiseBuf = null, lastTick = 0;
        function ensure() {
            if (ac) { if (ac.state === 'suspended') ac.resume(); return true; }
            var AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return false;
            try { ac = new AC(); } catch (e) { return false; }
            master = ac.createGain();
            master.gain.value = soundOn ? 1 : 0;
            master.connect(ac.destination);
            var len = ac.sampleRate;
            noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
            var d = noiseBuf.getChannelData(0);
            for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
            /* neon transformer hum: saw + square through a lowpass, slow AM for the buzz */
            humGain = ac.createGain();
            humGain.gain.value = 0;
            var lp = ac.createBiquadFilter();
            lp.type = 'lowpass'; lp.frequency.value = 520; lp.Q.value = 2;
            var o1 = ac.createOscillator(), o2 = ac.createOscillator();
            o1.type = 'sawtooth'; o1.frequency.value = 100;
            o2.type = 'square'; o2.frequency.value = 50.3;
            var g1 = ac.createGain(), g2 = ac.createGain();
            g1.gain.value = 0.5; g2.gain.value = 0.22;
            o1.connect(g1); g1.connect(lp);
            o2.connect(g2); g2.connect(lp);
            lp.connect(humGain); humGain.connect(master);
            var lfo = ac.createOscillator(), lg = ac.createGain();
            lfo.frequency.value = 7.3; lg.gain.value = 0.012;
            lfo.connect(lg); lg.connect(humGain.gain);
            o1.start(); o2.start(); lfo.start();
            /* electric buzz for when you get close to the tubes: mains-gated sizzle + a rasp */
            buzzGain = ac.createGain();
            buzzGain.gain.value = 0;
            buzzGain.connect(master);
            var bs = ac.createBufferSource();
            bs.buffer = noiseBuf; bs.loop = true;
            var bp = ac.createBiquadFilter();
            bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 0.9;
            var gate = ac.createGain(), glfo = ac.createOscillator(), glg = ac.createGain();
            gate.gain.value = 0.5; glfo.type = 'square'; glfo.frequency.value = 100; glg.gain.value = 0.5;
            glfo.connect(glg); glg.connect(gate.gain);
            bs.connect(bp); bp.connect(gate); gate.connect(buzzGain);
            var bo = ac.createOscillator(), bhp = ac.createBiquadFilter(), bog = ac.createGain();
            bo.type = 'sawtooth'; bo.frequency.value = 120; bhp.type = 'highpass'; bhp.frequency.value = 700; bog.gain.value = 0.35;
            bo.connect(bhp); bhp.connect(bog); bog.connect(buzzGain);
            bs.start(); glfo.start(); bo.start();
            return true;
        }
        function env(node, vol, dur, t0) {
            var g = ac.createGain();
            g.gain.setValueAtTime(Math.max(vol, 0.0001), t0);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
            node.connect(g); g.connect(master);
            return g;
        }
        function noise(dur, type, freq, q, vol, freqEnd) {
            if (!ac) return;
            var t0 = ac.currentTime;
            var src = ac.createBufferSource();
            src.buffer = noiseBuf;
            src.loop = true;
            src.playbackRate.value = rand(0.9, 1.1);
            var f = ac.createBiquadFilter();
            f.type = type; f.frequency.setValueAtTime(freq, t0); f.Q.value = q;
            if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
            src.connect(f);
            env(f, vol, dur, t0);
            src.start(t0, Math.random() * 0.5);
            src.stop(t0 + dur + 0.05);
        }
        function tone(freq, dur, vol, type, freqEnd) {
            if (!ac) return;
            var t0 = ac.currentTime;
            var o = ac.createOscillator();
            o.type = type || 'sine';
            o.frequency.setValueAtTime(freq, t0);
            if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
            env(o, vol, dur, t0);
            o.start(t0);
            o.stop(t0 + dur + 0.05);
        }
        return {
            ensure: ensure,
            setEnabled: function (on) { if (master) master.gain.setTargetAtTime(on ? 1 : 0, ac.currentTime, 0.02); },
            hum: function (level) { if (humGain) humGain.gain.setTargetAtTime(0.05 * level, ac.currentTime, 0.06); },
            buzz: function (level) { if (buzzGain) buzzGain.gain.setTargetAtTime(0.1 * level, ac.currentTime, level ? 0.08 : 0.15); },
            crackle: function () { if (!ac) return; noise(0.02, 'highpass', 3500, 1, 0.16); tone(rand(2800, 5200), 0.02, 0.04, 'sine'); },
            click: function () { if (!ensure()) return; noise(0.035, 'highpass', 1800, 1, 0.5); tone(1700, 0.03, 0.12, 'square', 900); },
            tick: function () {
                if (!ac) return;
                var now = ac.currentTime;
                if (now - lastTick < 0.05) return;
                lastTick = now;
                noise(0.014, 'bandpass', 2800, 3, 0.22);
            },
            launch: function () { if (!ensure()) return; noise(0.13, 'bandpass', 1100, 1.2, 0.35, 220); tone(170, 0.15, 0.18, 'sine', 70); },
            shatter: function () {
                if (!ensure()) return;
                noise(0.3, 'bandpass', 5200, 0.8, 0.6, 2600);
                for (var i = 0; i < 3; i++) tone(rand(2600, 6800), rand(0.15, 0.3), 0.1, 'sine');
                tone(90, 0.12, 0.2, 'sine', 45);
            },
            clink: function () { if (!ensure()) return; tone(2500, 0.12, 0.09, 'sine', 2300); tone(4100, 0.07, 0.04, 'sine'); },
            thunk: function (v) { if (!ensure()) return; tone(120, 0.16, 0.25 * v, 'sine', 55); noise(0.05, 'lowpass', 600, 1, 0.3 * v); },
            clank: function (v) { if (!ac) return; tone(1750, 0.18, 0.08 * v, 'triangle'); tone(2650, 0.12, 0.05 * v, 'sine'); noise(0.03, 'highpass', 3000, 1, 0.18 * v); }
        };
    })();

    /* ---------- power / tubes ---------- */
    function startFlicker(t) {
        t.flick = { t: 0, delay: rand(0, 0.35), dur: reduceMotion ? 0.3 : rand(0.6, 1.4) };
    }
    function setPower(on, silent) {
        power = on;
        tubes.forEach(function (t) {
            if (on && !t.broken) startFlicker(t);
            else t.flick = null;
        });
        if (!silent) sfx.click();
        updateHud();
    }
    function togglePower() { setPower(!power); }

    function breakTube(t, l, x, y) {
        t.broken = true;
        t.I = 0;
        t.flick = null;
        t.crack = { x: l.x, y: l.y, seed: Math.random() };
        brokenCount++;
        layerDirty = true;
        spawnSparks(x, y, t.c, 22);
        spawnShards(x, y, t.c, 12);
        sfx.shatter();
        shake = reduceMotion ? 0 : 7;
        if (!seenFirstBreak) { seenFirstBreak = true; toast('tube down. relax — fixing things is the job.'); }
        if (brokenCount === LETTER_COUNT) toast('lights out. the sign is dead.');
        updateHud();
    }
    function fixSign() {
        if (!brokenCount) return;
        brokenCount = 0;
        tubes.forEach(function (t) { t.broken = false; t.crack = null; t.I = 0; });
        layerDirty = true;
        if (!power) setPower(true);
        else { tubes.forEach(startFlicker); sfx.click(); }
        toast('new tubes fitted. good as new.');
        updateHud();
    }

    function updateLights(dt) {
        var i, t;
        for (i = 0; i < tubes.length; i++) {
            t = tubes[i];
            var target = power && !t.broken ? 1 : 0;
            if (t.flick) {
                var f = t.flick;
                f.t += dt;
                if (f.t < f.delay) t.I = 0;
                else if (f.t < f.delay + f.dur) {
                    var pr = (f.t - f.delay) / f.dur;
                    if (reduceMotion) t.I = pr;
                    else {
                        var pOn = 0.25 + 0.75 * pr * pr;
                        var was = t.I > 0.5;
                        t.I = Math.random() < pOn ? (0.75 + 0.25 * Math.random()) : Math.random() * 0.12;
                        if (was !== (t.I > 0.5) && Math.random() < 0.6) sfx.tick();
                    }
                } else { t.flick = null; t.I = 1; }
            } else {
                t.I += (target - t.I) * Math.min(1, dt * 22);
                if (target === 1 && !reduceMotion) {
                    if (t.blink > 0) {
                        t.blink -= dt;
                        t.I = t.blink > 0 ? 0.35 + Math.random() * 0.4 : 1;
                    } else if (Math.random() < dt / 13) {
                        t.blink = rand(0.05, 0.16);
                        sfx.tick();
                    }
                }
            }
        }
        var letters = 0;
        for (i = 0; i < LETTER_COUNT; i++) letters += tubes[i].I;
        var ring = tubes[LETTER_COUNT].I;
        pinkLight += (letters / LETTER_COUNT - pinkLight) * Math.min(1, dt * 16);
        blueLight += (ring - blueLight) * Math.min(1, dt * 16);
        lit = clamp(pinkLight * 0.88 + blueLight * 0.28, 0, 1);
        if (Math.abs(lit - litShown) > 0.01) {
            litShown = lit;
            root.style.setProperty('--lit', lit.toFixed(3));
        }
        sfx.hum(power ? 0.35 + 0.65 * lit : 0);
        var buzzing = hoverSign && power && lit > 0.05;
        sfx.buzz(buzzing ? lit : 0);
        if (buzzing && Math.random() < dt * 5) sfx.crackle();
        if (!layerDirty) {
            for (i = 0; i < tubes.length; i++) {
                var v = tubes[i].broken ? -1 : tubes[i].I;
                if (layerI[i] === undefined || Math.abs(v - layerI[i]) > 0.03) { layerDirty = true; break; }
            }
        }
    }

    /* ---------- physics ---------- */
    function physics(dt) {
        time += dt;
        var pts = sign.pts, i, p;
        for (i = 0; i < 4; i++) {
            p = pts[i];
            var vx = (p.x - p.px) * DAMP, vy = (p.y - p.py) * DAMP;
            p.px = p.x; p.py = p.y;
            p.x += vx; p.y += vy + G * dt * dt;
        }
        if (sign.drag) {
            var b = localToWorld(sign.drag.u, sign.drag.v);
            var ddx = (pointer.x - b.x) * 0.22, ddy = (pointer.y - b.y) * 0.22;
            for (i = 0; i < 4; i++) {
                pts[i].x += ddx; pts[i].y += ddy;
                pts[i].px += ddx * 0.8; pts[i].py += ddy * 0.8;
            }
        }
        for (var k = 0; k < ITER; k++) {
            for (i = 0; i < sign.rods.length; i++) {
                var r = sign.rods[i], a = pts[r[0]], c = pts[r[1]];
                var dx = c.x - a.x, dy = c.y - a.y;
                var d = Math.sqrt(dx * dx + dy * dy) || 0.0001;
                var diff = (d - r[2]) / d * 0.5;
                a.x += dx * diff; a.y += dy * diff;
                c.x -= dx * diff; c.y -= dy * diff;
            }
            for (i = 0; i < 2; i++) {
                var ch = sign.chains[i], q = pts[ch.p];
                var cx = q.x - ch.ax, cy = q.y - ch.ay;
                var cd = Math.sqrt(cx * cx + cy * cy) || 0.0001;
                if (cd > ch.L) {
                    var over = cd - ch.L;
                    q.x -= cx / cd * over; q.y -= cy / cd * over;
                    if (k === 0) {
                        if (ch.slack && over > 1.5 && ch.cool <= 0) { sfx.clank(clamp(over / 9, 0.2, 1)); ch.cool = 0.25; }
                        ch.slack = false;
                    }
                } else if (k === 0 && cd < ch.L - 2) ch.slack = true;
            }
        }
        for (i = 0; i < 2; i++) if (sign.chains[i].cool > 0) sign.chains[i].cool -= dt;

        /* pebbles */
        for (i = pebbles.length - 1; i >= 0; i--) {
            var pb = pebbles[i];
            pb.vy += G * dt;
            pb.x += pb.vx * dt; pb.y += pb.vy * dt;
            pb.rot += pb.spin * dt;
            if (pb.spent) {
                pb.life -= dt * 1.4;
                if (pb.life <= 0 || pb.y > H + 40) pebbles.splice(i, 1);
                continue;
            }
            if (pb.y > H + 40 || pb.x < -60 || pb.x > W + 60 || pb.y < -H * 3) { pebbles.splice(i, 1); continue; }
            if (Math.abs(pb.x - sw.x) < sw.w / 2 + pb.r && Math.abs(pb.y - sw.y) < sw.h / 2 + pb.r) { hitSwitch(pb); continue; }
            var l = worldToLocal(pb.x, pb.y);
            if (l.x > -pb.r && l.x < sign.w + pb.r && l.y > -pb.r && l.y < sign.h + pb.r) {
                var t = tubeAt(l.x, l.y, pb.r);
                if (t) hitTube(t, pb, l);
            }
        }

        /* switch rocker + knock wobble */
        var target = power ? 1 : 0;
        sw.anim += (target - sw.anim) * Math.min(1, dt * 26);
        sw.knockV += (-sw.knock * 320 - sw.knockV * 9) * dt;
        sw.knock += sw.knockV * dt;

        /* slingshot */
        if (!sling.ready) {
            sling.respawn -= dt;
            if (sling.respawn <= 0) { sling.ready = true; sling.pop = 1; }
        }
        sling.pop = Math.max(0, sling.pop - dt * 4);
        sling.wobble = Math.max(0, sling.wobble - dt * 3);
    }

    function spendPebble(pb) {
        pb.spent = true;
        pb.vx = -pb.vx * 0.12 + rand(-40, 40);
        pb.vy = -Math.abs(pb.vy) * 0.15 - 60;
        pb.spin = rand(-14, 14);
    }
    function hitTube(t, pb, l) {
        var sp = Math.sqrt(pb.vx * pb.vx + pb.vy * pb.vy) || 1;
        var ux = pb.vx / sp, uy = pb.vy / sp;
        var mag = Math.min(9, sp * 0.0045) * KICK;
        shoveSign(clamp(l.x / sign.w, 0, 1), clamp(l.y / sign.h, 0, 1), ux * mag, uy * mag);
        if (!t.broken) breakTube(t, l, pb.x, pb.y);
        else { sfx.clink(); spawnDust(pb.x, pb.y, 5); spawnSparks(pb.x, pb.y, { rgb: '200,200,210' }, 4); }
        spendPebble(pb);
    }
    function hitSwitch(pb) {
        togglePower();
        sw.knockV += (pb.vx > 0 ? 1 : -1) * 18;
        spawnSparks(pb.x, pb.y, { rgb: '255,220,160' }, 8);
        spawnDust(pb.x, pb.y, 4);
        sfx.thunk(0.8);
        if (!seenTrick) { seenTrick = true; toast('trick shot. the switch, from the slingshot.'); }
        spendPebble(pb);
    }

    /* ---------- particles ---------- */
    function spawnSparks(x, y, c, n) {
        for (var i = 0; i < n; i++) {
            var a = rand(0, TAU), s = rand(120, 520);
            particles.push({ kind: 'spark', x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 80, life: rand(0.25, 0.6), max: 0.6, rgb: c.rgb });
        }
    }
    function spawnShards(x, y, c, n) {
        for (var i = 0; i < n; i++) {
            var a = rand(0, TAU), s = rand(60, 300);
            particles.push({ kind: 'shard', x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 120, rot: rand(0, TAU), spin: rand(-12, 12), size: rand(2, 5), life: rand(1.0, 1.8), max: 1.8, rgb: c.rgb });
        }
    }
    function spawnDust(x, y, n) {
        for (var i = 0; i < n; i++) {
            var a = rand(0, TAU), s = rand(20, 90);
            particles.push({ kind: 'dust', x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 30, size: rand(3, 7), life: rand(0.4, 0.8), max: 0.8 });
        }
    }
    function updateParticles(dt) {
        for (var i = particles.length - 1; i >= 0; i--) {
            var p = particles[i];
            p.life -= dt;
            if (p.life <= 0) { particles.splice(i, 1); continue; }
            if (p.kind === 'shard') { p.vy += G * 0.9 * dt; p.rot += p.spin * dt; }
            else if (p.kind === 'spark') { p.vy += G * 0.5 * dt; p.vx *= 0.985; p.vy *= 0.985; }
            else { p.vx *= 0.96; p.vy *= 0.96; p.vy -= 20 * dt; }
            p.x += p.vx * dt; p.y += p.vy * dt;
        }
    }

    /* ---------- slingshot ---------- */
    function updateAim() {
        var dx = pointer.x - sling.restX, dy = pointer.y - sling.restY;
        var len = Math.sqrt(dx * dx + dy * dy);
        if (len > sling.maxPull) { dx *= sling.maxPull / len; dy *= sling.maxPull / len; len = sling.maxPull; }
        sling.aim = { x: sling.restX + dx, y: sling.restY + dy, pull: len };
    }
    function makeShape() {
        var s = [];
        for (var i = 0; i < 7; i++) s.push(rand(0.82, 1.12));
        return s;
    }
    function launch() {
        var a = sling.aim;
        sling.aim = null;
        if (!a || a.pull < 10) return;
        var vx = (sling.restX - a.x) * POWER, vy = (sling.restY - a.y) * POWER;
        pebbles.push({ x: a.x, y: a.y, vx: vx, vy: vy, r: sling.r, rot: 0, spin: rand(-9, 9), spent: false, life: 1, shape: makeShape() });
        shots++;
        sling.ready = false;
        sling.respawn = 0.3;
        sling.wobble = 1;
        sfx.launch();
        updateHud();
    }

    /* ---------- HUD ---------- */
    var toastTimer = 0;
    function toast(msg) {
        if (!ui.toast) return;
        ui.toast.textContent = msg;
        ui.toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { ui.toast.classList.remove('show'); }, 2800);
    }
    function updateHud() {
        var dead = brokenCount === LETTER_COUNT;
        if (ui.state) ui.state.textContent = !power ? 'off' : (dead ? 'dead' : 'on');
        if (ui.shots) ui.shots.textContent = shots;
        if (ui.tubes) ui.tubes.textContent = brokenCount;
        if (ui.fix) ui.fix.hidden = brokenCount === 0;
        if (ui.scene) ui.scene.classList.toggle('closed', dead);
        canvas.setAttribute('aria-label', 'Neon OPEN sign, ' + (power ? 'powered on' : 'switched off') + ', ' + brokenCount + ' of ' + LETTER_COUNT + ' tubes broken');
    }
    function tickClock() {
        if (!ui.clock) return;
        var d = new Date(), h = d.getHours(), m = d.getMinutes();
        var ap = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        ui.clock.textContent = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ' ' + ap;
    }

    /* ---------- drawing ---------- */
    function strokePolys(c, polys) {
        c.beginPath();
        for (var i = 0; i < polys.length; i++) {
            var poly = polys[i];
            c.moveTo(poly[0].x, poly[0].y);
            for (var j = 1; j < poly.length; j++) c.lineTo(poly[j].x, poly[j].y);
        }
        c.stroke();
    }
    function renderLayer() {
        var pad = sign.pad, lw = sign.w + 2 * pad, lh = sign.h + 2 * pad;
        var pw = Math.round(lw * dpr), ph = Math.round(lh * dpr);
        if (layer.width !== pw || layer.height !== ph) { layer.width = pw; layer.height = ph; }
        lctx.setTransform(dpr, 0, 0, dpr, pad * dpr, pad * dpr);
        lctx.clearRect(-pad, -pad, lw, lh);
        lctx.lineCap = 'round';
        lctx.lineJoin = 'round';
        var tw = sign.tubeW;
        tubes.forEach(function (t) {
            var I = t.broken ? 0 : t.I;
            lctx.shadowBlur = 0;
            lctx.globalAlpha = 1;
            lctx.strokeStyle = t.broken ? 'rgba(58,34,44,0.95)' : 'rgba(44,26,36,0.9)';
            lctx.lineWidth = tw * 1.2;
            strokePolys(lctx, t.polys);
            if (I > 0.01) {
                lctx.strokeStyle = t.c.glow;
                lctx.shadowColor = t.c.glow;
                lctx.globalAlpha = 0.55 * I;
                lctx.lineWidth = tw * 2.4;
                lctx.shadowBlur = tw * 7 * dpr;
                strokePolys(lctx, t.polys);
                lctx.strokeStyle = t.c.mid;
                lctx.globalAlpha = 0.85 * I;
                lctx.lineWidth = tw * 1.3;
                lctx.shadowBlur = tw * 2.5 * dpr;
                strokePolys(lctx, t.polys);
                lctx.strokeStyle = t.c.core;
                lctx.globalAlpha = I;
                lctx.lineWidth = tw * 0.55;
                lctx.shadowBlur = 0;
                strokePolys(lctx, t.polys);
            }
            if (t.broken && t.crack) {
                var cr = t.crack, s = cr.seed;
                lctx.globalAlpha = 1;
                lctx.shadowBlur = 0;
                lctx.fillStyle = '#07080b';
                lctx.beginPath(); lctx.arc(cr.x, cr.y, tw * 0.55, 0, TAU); lctx.fill();
                lctx.strokeStyle = 'rgba(255,255,255,0.55)';
                lctx.lineWidth = 1;
                for (var i = 0; i < 4; i++) {
                    var a = s * TAU + i * 1.7, len = tw * (1.4 + ((s * 7 + i) % 1) * 1.6);
                    lctx.beginPath();
                    lctx.moveTo(cr.x, cr.y);
                    lctx.lineTo(cr.x + Math.cos(a) * len * 0.5, cr.y + Math.sin(a) * len * 0.5);
                    lctx.lineTo(cr.x + Math.cos(a + 0.5) * len, cr.y + Math.sin(a + 0.5) * len);
                    lctx.stroke();
                }
            }
        });
        lctx.globalAlpha = 1;
        layerDirty = false;
        layerI = tubes.map(function (t) { return t.broken ? -1 : t.I; });
    }

    function screw(x, y) {
        ctx.beginPath(); ctx.arc(x, y, 2.4, 0, TAU);
        ctx.fillStyle = '#3b3f4b'; ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x - 1.6, y - 1.2); ctx.lineTo(x + 1.6, y + 1.2); ctx.stroke();
    }

    function drawChain(ax, ay, bx, by, L, alpha) {
        var dx = bx - ax, dy = by - ay, len = Math.sqrt(dx * dx + dy * dy);
        var slack = Math.max(0, L - len);
        var n = Math.max(2, Math.round(L / 9));
        var mx = (ax + bx) / 2 + (slack > 1 ? (dx > 0 ? -1 : 1) * slack * 0.25 : 0);
        var my = (ay + by) / 2 + slack * 0.75;
        ctx.strokeStyle = 'rgba(196,202,216,' + alpha + ')';
        ctx.lineWidth = 1.5;
        var px = ax, py = ay;
        for (var i = 1; i <= n; i++) {
            var t = i / n, it = 1 - t;
            var x = it * it * ax + 2 * it * t * mx + t * t * bx;
            var y = it * it * ay + 2 * it * t * my + t * t * by;
            var cx = (px + x) / 2, cy = (py + y) / 2;
            var ang = Math.atan2(y - py, x - px);
            var half = Math.sqrt((x - px) * (x - px) + (y - py) * (y - py)) / 2;
            ctx.beginPath();
            ctx.ellipse(cx, cy, Math.max(1, half), i % 2 ? 2 : 3.2, ang, 0, TAU);
            ctx.stroke();
            px = x; py = y;
        }
    }

    function drawSign() {
        var p = sign.pts, w = sign.w, h = sign.h;
        var chainA = 0.35 + 0.5 * lit;
        for (var i = 0; i < 2; i++) {
            var ch = sign.chains[i], q = p[ch.p];
            drawChain(ch.ax, ch.ay, q.x, q.y, ch.L, chainA);
        }
        var f = frameAxes();
        ctx.save();
        ctx.translate(f.ox, f.oy);
        ctx.rotate(Math.atan2(f.uy, f.ux));
        var r = h * 0.07;
        ctx.fillStyle = '#0c0d12';
        roundRect(ctx, -1, -1, w + 2, h + 2, r); ctx.fill();
        var g = ctx.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, '#1c1d27'); g.addColorStop(1, '#0f1016');
        ctx.fillStyle = g;
        roundRect(ctx, 1, 1, w - 2, h - 2, r); ctx.fill();
        if (lit > 0.02) {
            var wash = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * 0.62);
            wash.addColorStop(0, 'rgba(' + PINK.rgb + ',' + (0.2 * pinkLight) + ')');
            wash.addColorStop(1, 'rgba(' + PINK.rgb + ',0)');
            ctx.fillStyle = wash;
            roundRect(ctx, 1, 1, w - 2, h - 2, r); ctx.fill();
        }
        ctx.strokeStyle = 'rgba(255,255,255,' + (0.07 + 0.14 * lit) + ')';
        ctx.lineWidth = 1;
        roundRect(ctx, 0.5, 0.5, w - 1, h - 1, r); ctx.stroke();
        screw(9, 9); screw(w - 9, 9); screw(9, h - 9); screw(w - 9, h - 9);
        /* hooks where the chains bolt on */
        ctx.strokeStyle = 'rgba(196,202,216,' + chainA + ')';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, 0, 4.5, 0, TAU); ctx.stroke();
        ctx.beginPath(); ctx.arc(w, 0, 4.5, 0, TAU); ctx.stroke();
        if (layerDirty) renderLayer();
        var buzzing = hoverSign && power && lit > 0.05 && !reduceMotion;
        ctx.globalAlpha = buzzing ? 0.9 + 0.1 * Math.random() : 0.965 + 0.035 * Math.sin(time * 37) * Math.sin(time * 11.3);
        ctx.drawImage(layer, -sign.pad, -sign.pad, w + 2 * sign.pad, h + 2 * sign.pad);
        if (buzzing && hoverTube && !hoverTube.broken && hoverTube.I > 0.5) {
            /* the tube under the pointer sizzles a little brighter */
            ctx.lineCap = 'round'; ctx.lineJoin = 'round';
            ctx.globalAlpha = 0.2 + 0.4 * Math.random();
            ctx.strokeStyle = hoverTube.c.mid;
            ctx.shadowColor = hoverTube.c.glow;
            ctx.shadowBlur = sign.tubeW * 3 * dpr;
            ctx.lineWidth = sign.tubeW * 1.2;
            strokePolys(ctx, hoverTube.polys);
            ctx.shadowBlur = 0;
        }
        ctx.globalAlpha = 1;
        ctx.restore();
    }

    function drawSwitch() {
        var w = sw.w, h = sw.h;
        ctx.save();
        ctx.translate(sw.x, sw.y);
        ctx.rotate(sw.knock * 0.05);
        ctx.globalAlpha = 0.6 + 0.4 * lit;
        var g = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
        g.addColorStop(0, '#2c2f3a'); g.addColorStop(1, '#161820');
        ctx.fillStyle = g;
        roundRect(ctx, -w / 2, -h / 2, w, h, 6); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 1;
        roundRect(ctx, -w / 2 + 0.5, -h / 2 + 0.5, w - 1, h - 1, 6); ctx.stroke();
        screw(0, -h / 2 + 8); screw(0, h / 2 - 8);
        ctx.fillStyle = 'rgba(255,255,255,0.32)';
        ctx.font = '600 ' + (w > 50 ? 7 : 6) + 'px ' + MONO;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('ON', 0, -h * 0.29);
        ctx.fillText('OFF', 0, h * 0.3);
        var rw = w * 0.5, rh = h * 0.42;
        ctx.fillStyle = '#07080b';
        roundRect(ctx, -rw / 2, -rh / 2, rw, rh, 4); ctx.fill();
        /* rocker: on = top end pressed in */
        var t = sw.anim;
        var rg = ctx.createLinearGradient(0, -rh / 2, 0, rh / 2);
        var hi = '#eef0f5', lo = '#8d93a3';
        rg.addColorStop(0, t > 0.5 ? lo : hi);
        rg.addColorStop(0.5, '#c8ccd6');
        rg.addColorStop(1, t > 0.5 ? hi : lo);
        ctx.fillStyle = rg;
        var tilt = (t - 0.5) * 2;
        var y0 = -rh / 2 + 2 + (tilt > 0 ? 3 : 0), y1 = rh / 2 - 2 - (tilt < 0 ? 3 : 0);
        roundRect(ctx, -rw / 2 + 2, y0, rw - 4, y1 - y0, 3); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.beginPath(); ctx.moveTo(-rw / 2 + 4, tilt * rh * 0.1); ctx.lineTo(rw / 2 - 4, tilt * rh * 0.1); ctx.stroke();
        /* pilot lamp */
        ctx.beginPath(); ctx.arc(0, h * 0.13, 2.4, 0, TAU);
        ctx.fillStyle = power ? '#ff3f7a' : '#3a2a30';
        if (power) { ctx.shadowColor = '#ff3f7a'; ctx.shadowBlur = 9 * dpr; }
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.restore();
    }

    function drawPebble(x, y, r, rot, shape, alpha) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(rot);
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        for (var i = 0; i < 7; i++) {
            var a = i / 7 * TAU, rr = r * shape[i];
            if (i) ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); else ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
        }
        ctx.closePath();
        ctx.fillStyle = '#9c9ca6';
        ctx.fill();
        ctx.strokeStyle = '#4a4a54';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.beginPath(); ctx.arc(-r * 0.3, -r * 0.3, r * 0.28, 0, TAU); ctx.fill();
        ctx.restore();
    }
    var restShape = [1, 0.95, 1.05, 0.9, 1.08, 0.97, 1.02];

    function drawSling() {
        var x = sling.x, y = sling.y, top = sling.top, s = sling.spread;
        var wob = Math.sin(sling.wobble * 14) * sling.wobble * 3;
        ctx.save();
        ctx.globalAlpha = 0.75 + 0.25 * lit;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        var fork = function (lw, color) {
            ctx.strokeStyle = color; ctx.lineWidth = lw;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x, top + 54);
            ctx.quadraticCurveTo(x - 2, top + 24, x - s + wob, top);
            ctx.moveTo(x, top + 54);
            ctx.quadraticCurveTo(x + 2, top + 24, x + s + wob, top);
            ctx.stroke();
        };
        fork(16, '#33200f');
        fork(11, '#8a5a34');
        ctx.globalAlpha *= 0.45;
        fork(3, '#caa070');
        ctx.globalAlpha = 0.75 + 0.25 * lit;
        /* grip wrap */
        ctx.strokeStyle = '#2a1c12';
        ctx.lineWidth = 2;
        for (var i = 0; i < 5; i++) { ctx.beginPath(); ctx.moveTo(x - 7, y - 16 - i * 7); ctx.lineTo(x + 7, y - 19 - i * 7); ctx.stroke(); }
        if (sling.ready) {
            var px = sling.restX, py = sling.restY;
            if (sling.aim) { px = sling.aim.x; py = sling.aim.y; }
            var pop = 1 + sling.pop * 0.5;
            ctx.strokeStyle = '#2b2b30';
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.moveTo(x - s + wob, top); ctx.lineTo(px - 6, py);
            ctx.moveTo(x + s + wob, top); ctx.lineTo(px + 6, py);
            ctx.stroke();
            ctx.fillStyle = '#4b3a2b';
            roundRect(ctx, px - 8, py - 4, 16, 9, 3); ctx.fill();
            drawPebble(px, py, sling.r * pop, 0, restShape, 1);
        }
        ctx.restore();
        if (sling.aim && sling.aim.pull > 10) {
            var vx = (sling.restX - sling.aim.x) * POWER, vy = (sling.restY - sling.aim.y) * POWER;
            ctx.fillStyle = '#ffffff';
            for (var k = 1; k <= 16; k++) {
                var tt = k * 0.046;
                var dx = sling.aim.x + vx * tt, dy = sling.aim.y + vy * tt + 0.5 * G * tt * tt;
                ctx.globalAlpha = 0.55 * (1 - k / 17);
                ctx.beginPath(); ctx.arc(dx, dy, 2, 0, TAU); ctx.fill();
            }
            ctx.globalAlpha = 1;
        }
    }

    function drawParticles() {
        for (var i = 0; i < particles.length; i++) {
            var p = particles[i], k = p.life / p.max;
            if (p.kind === 'spark') {
                ctx.globalCompositeOperation = 'lighter';
                ctx.strokeStyle = 'rgba(' + p.rgb + ',' + (0.9 * k) + ')';
                ctx.lineWidth = 1.6;
                ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.02, p.y - p.vy * 0.02); ctx.stroke();
                ctx.globalCompositeOperation = 'source-over';
            } else if (p.kind === 'shard') {
                ctx.save();
                ctx.translate(p.x, p.y); ctx.rotate(p.rot);
                ctx.fillStyle = 'rgba(' + p.rgb + ',' + (0.75 * Math.min(1, k * 2)) + ')';
                ctx.beginPath(); ctx.moveTo(-p.size, p.size * 0.6); ctx.lineTo(p.size, 0); ctx.lineTo(-p.size * 0.4, -p.size); ctx.closePath(); ctx.fill();
                ctx.restore();
            } else {
                ctx.fillStyle = 'rgba(180,180,190,' + (0.22 * k) + ')';
                ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1.6 - k * 0.6), 0, TAU); ctx.fill();
            }
        }
        for (var j = 0; j < pebbles.length; j++) {
            var pb = pebbles[j];
            drawPebble(pb.x, pb.y, pb.r, pb.rot, pb.shape, pb.spent ? Math.max(0, pb.life) : 1);
        }
    }

    function draw() {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        if (shake > 0.2) {
            ctx.translate(rand(-shake, shake), rand(-shake, shake));
            shake *= 0.86;
        }
        var c = localToWorld(0.5, 0.5);
        var lightR = Math.max(sign.w * 1.4, H * 0.55);

        /* light thrown on the wall */
        if (lit > 0.01) {
            ctx.globalCompositeOperation = 'lighter';
            var gp = ctx.createRadialGradient(c.x, c.y, sign.h * 0.2, c.x, c.y, lightR * 0.95);
            gp.addColorStop(0, 'rgba(' + PINK.rgb + ',' + (0.2 * pinkLight) + ')');
            gp.addColorStop(1, 'rgba(' + PINK.rgb + ',0)');
            ctx.fillStyle = gp;
            ctx.fillRect(0, 0, W, H);
            if (blueLight > 0.02) {
                var gb = ctx.createRadialGradient(c.x, c.y, sign.h * 0.3, c.x, c.y, lightR * 0.7);
                gb.addColorStop(0, 'rgba(' + BLUE.rgb + ',' + (0.09 * blueLight) + ')');
                gb.addColorStop(1, 'rgba(' + BLUE.rgb + ',0)');
                ctx.fillStyle = gb;
                ctx.fillRect(0, 0, W, H);
            }
            ctx.globalCompositeOperation = 'source-over';
        }
        /* darkness — a soft hole where the sign's light reaches */
        var dark = 0.93;
        var gd = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, lightR * 1.7);
        gd.addColorStop(0, 'rgba(4,5,8,' + (dark * (1 - lit)) + ')');
        gd.addColorStop(0.55, 'rgba(4,5,8,' + (dark * (1 - lit) + 0.27 * lit) + ')');
        gd.addColorStop(1, 'rgba(4,5,8,' + dark + ')');
        ctx.fillStyle = gd;
        ctx.fillRect(-20, -20, W + 40, H + 40);

        drawSign();
        drawSwitch();
        drawSling();
        drawParticles();
    }

    /* ---------- main loop ---------- */
    function frame(t) {
        requestAnimationFrame(frame);
        if (W !== window.innerWidth || H !== window.innerHeight) layout();
        if (!lastT) lastT = t;
        var dt = Math.min(0.05, (t - lastT) / 1000);
        lastT = t;
        acc += dt;
        var n = 0;
        while (acc >= STEP && n < 8) { physics(STEP); acc -= STEP; n++; }
        if (n === 8) acc = 0;
        updateLights(dt);
        updateParticles(dt);
        draw();
    }

    /* ---------- input ---------- */
    function nearPebble(x, y) {
        if (!sling.ready) return false;
        var d = Math.sqrt((x - sling.restX) * (x - sling.restX) + (y - sling.restY) * (y - sling.restY));
        if (d < (coarse ? 48 : 30)) return true;
        return coarse && x < sling.x + 95 && y > sling.top - 95;
    }
    function overSwitch(x, y) { return Math.abs(x - sw.x) < sw.w / 2 + 8 && Math.abs(y - sw.y) < sw.h / 2 + 8; }
    function overSign(x, y) {
        var l = worldToLocal(x, y);
        return l.x >= -8 && l.x <= sign.w + 8 && l.y >= -8 && l.y <= sign.h + 8 ? l : null;
    }
    function setCursor(x, y) {
        if (pointer.mode) return;
        canvas.style.cursor = nearPebble(x, y) ? 'grab' : overSwitch(x, y) ? 'pointer' : overSign(x, y) ? 'grab' : 'default';
    }
    canvas.addEventListener('pointerdown', function (e) {
        if (pointer.id !== null) return;
        sfx.ensure();
        pointer.id = e.pointerId;
        pointer.x = e.clientX; pointer.y = e.clientY;
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* older browsers */ }
        var x = e.clientX, y = e.clientY;
        if (nearPebble(x, y)) {
            pointer.mode = 'aim';
            updateAim();
            canvas.style.cursor = 'grabbing';
            return;
        }
        if (overSwitch(x, y)) {
            pointer.mode = 'switch';
            togglePower();
            sw.knockV += 6;
            return;
        }
        var l = overSign(x, y);
        if (l) {
            pointer.mode = 'sign';
            sign.drag = { u: clamp(l.x / sign.w, 0, 1), v: clamp(l.y / sign.h, 0, 1) };
            hoverSign = true;
            hoverTube = tubeAt(l.x, l.y, 8);
            canvas.style.cursor = 'grabbing';
            return;
        }
        pointer.mode = 'none';
    });
    canvas.addEventListener('pointermove', function (e) {
        if (pointer.id !== null && e.pointerId !== pointer.id) return;
        pointer.x = e.clientX; pointer.y = e.clientY;
        if (pointer.mode === 'aim') updateAim();
        else if (pointer.id === null) { updateHover(e.clientX, e.clientY); setCursor(e.clientX, e.clientY); }
    });
    function release(e) {
        if (pointer.id === null || e.pointerId !== pointer.id) return;
        if (pointer.mode === 'aim') { if (e.type === 'pointercancel') sling.aim = null; else launch(); }
        if (pointer.mode === 'sign') sign.drag = null;
        pointer.id = null;
        pointer.mode = null;
        if (e.pointerType === 'touch') { hoverSign = false; hoverTube = null; }
        else updateHover(e.clientX, e.clientY);
        setCursor(e.clientX, e.clientY);
    }
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    function updateHover(x, y) {
        var l = overSign(x, y);
        hoverSign = !!l;
        hoverTube = l ? tubeAt(l.x, l.y, 8) : null;
    }
    canvas.addEventListener('pointerleave', function () { if (pointer.id === null) { hoverSign = false; hoverTube = null; } });
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    document.addEventListener('keydown', function (e) {
        var tag = (e.target && e.target.tagName) || '';
        if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT') return;
        if (e.key === ' ' || e.key === 'Enter' || e.key === 'l' || e.key === 'L') { e.preventDefault(); sfx.ensure(); togglePower(); sw.knockV += 6; }
        else if (e.key === 'r' || e.key === 'R') { sfx.ensure(); fixSign(); }
        else if (e.key === 'm' || e.key === 'M') setSound(!soundOn);
    });

    function setSound(on) {
        soundOn = on;
        sfx.ensure();
        sfx.setEnabled(on);
        if (ui.sound) { ui.sound.textContent = 'sound: ' + (on ? 'on' : 'off'); ui.sound.setAttribute('aria-pressed', on ? 'true' : 'false'); }
        try { localStorage.setItem('neon-sound', on ? '1' : '0'); } catch (err) { /* private mode */ }
    }
    try { if (localStorage.getItem('neon-sound') === '0') { soundOn = false; if (ui.sound) ui.sound.textContent = 'sound: off'; } } catch (err) { /* ignore */ }
    if (ui.sound) ui.sound.addEventListener('click', function () { setSound(!soundOn); });
    if (ui.fix) ui.fix.addEventListener('click', function () { sfx.ensure(); fixSign(); });

    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) { lastT = 0; return; }
        hoverSign = false; hoverTube = null;
        sfx.buzz(0);
    });


    /* ---------- go ---------- */
    layout();
    tickClock();
    setInterval(tickClock, 15000);
    updateHud();
    requestAnimationFrame(frame);
    setTimeout(function () { setPower(true, true); }, 650);
})();
