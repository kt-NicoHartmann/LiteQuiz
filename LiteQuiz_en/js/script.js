let peer, conn, connections = [],
    isLecturer = false;
let quizData = [],
    currentQuestion = 0,
    players = [],
    timerInterval;
let answersThisRound = 0;
let roundStats = {};
let selectedIdx = null;
let studentLastAnswerIdx = null;
let studentScoreBeforeRound = 0;
let myPeerId = null;

const LIMIT = 20000;

// ── FETCH DYNAMIC TURN CREDENTIALS ────────────────────────────────────
async function fetchIceServers() {
    try {
        // Fetches the time-limited credentials from Node.js backend via Nginx
        const response = await fetch('https://nicohartmann.dev/api/get-ice-credentials');
        const data = await response.json();

        return [{
                urls: 'stun:nicohartmann.dev:3478'
            },
            {
                urls: 'turn:nicohartmann.dev:3478',
                username: data.username,
                credential: data.credential
            }
        ];
    } catch (error) {
        console.error("Error loading TURN credentials, falling back to STUN:", error);
        // Fallback: If the Node backend is offline, at least try STUN
        return [{
            urls: 'stun:nicohartmann.dev:3478'
        }];
    }
}

// Helper function to create Peer configuration
function createPeerConfig(iceServers) {
    return {
        host: 'nicohartmann.dev',
        port: 443,
        path: '/litequiz',
        secure: true,
        debug: 1,
        config: {
            iceServers: iceServers
        }
    };
}

// ── Connection status badge ────────────────────────────────────────────
function setStatus(state, label) {
    const el = document.getElementById('conn-status');
    el.className = state;
    el.textContent = '● ' + label;
}

function hideStatus() {
    document.getElementById('conn-status').className = 'hidden-badge';
}

// ── MD parser ─────────────────────────────────────────────────────────
document.getElementById('md-input').addEventListener('change', function(e) {
    const reader = new FileReader();
    const errorEl = document.getElementById('upload-error');
    errorEl.classList.add('hidden');

    reader.onload = (event) => {
        try {
            const rawData = event.target.result.split(/---|\*\*\*/).filter(b => b.trim().length > 5);
            if (rawData.length === 0) throw "No questions found.";

            const parsed = rawData.map((block, idx) => {
                const lines = block.trim().split('\n');
                const question = lines[0].replace(/^# |^Question: /, '').trim();
                const answers = lines.slice(1).filter(l => l.includes('[')).map((l, i) => ({
                    originalIndex: i,
                    text: l.replace(/- \[[ x]\] /, '').trim(),
                    correct: l.includes('[x]')
                }));
                const correctCount = answers.filter(a => a.correct).length;
                if (answers.length < 2) throw `Question ${idx+1}: At least 2 answers required.`;
                if (correctCount !== 1) throw `Question ${idx+1}: Mark exactly one correct answer with [x].`;
                return {
                    question,
                    answers
                };
            });

            quizData = parsed;
            setupLecturer();
        } catch (err) {
            errorEl.innerText = "⚠️ ERROR: " + err;
            errorEl.classList.remove('hidden');
            e.target.value = '';
        }
    };
    reader.readAsText(e.target.files[0]);
});

// ── Lecturer setup ────────────────────────────────────────────────────
async function setupLecturer() {
    isLecturer = true;
    const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();

    setStatus('connecting', 'Loading security token…');

    // Wait for dynamic ice servers first
    const iceServers = await fetchIceServers();
    const peerConfig = createPeerConfig(iceServers);

    setStatus('connecting', 'Connecting…');
    peer = new Peer(roomId, peerConfig);

    peer.on('open', id => {
        hideStatus();
        showView('lobby');
        document.getElementById('display-room-id').innerText = id;
        document.getElementById('start-btn').classList.remove('hidden');
        document.getElementById('qr-container').classList.remove('hidden');
        generateQR(id);
    });

    peer.on('error', err => {
        console.error('[Host PeerJS]', err);
        if (err.type === 'unavailable-id') {
            peer.destroy();
            setupLecturer();
            return;
        }
        setStatus('error', 'Connection error – please reload page');
    });

    peer.on('disconnected', () => {
        setStatus('connecting', 'Reconnecting…');
        peer.reconnect();
    });

    peer.on('connection', c => {
        c.on('data', data => {
            if (data.type === 'join') {
                if (players.find(p => p.id === c.peer)) return;
                players.push({
                    id: c.peer,
                    name: data.name,
                    score: 0,
                    answered: false
                });
                connections.push(c);
                updatePlayerList();
            }
            if (data.type === 'answer') handleAnswer(c.peer, data.index, data.timeBonus);
        });
        c.on('error', err => console.warn('[conn error]', c.peer, err));
    });
}

function generateQR(id) {
    const url = `${window.location.origin}${window.location.pathname}?room=${id}`;
    document.getElementById('share-url').innerText = url;
    document.getElementById("qrcode").innerHTML = "";
    new QRCode(document.getElementById("qrcode"), {
        text: url,
        width: 160,
        height: 160
    });
}

function copyLink() {
    navigator.clipboard.writeText(document.getElementById('share-url').innerText);
    alert("Link copied!");
}

// ── Student join ──────────────────────────────────────────────────────
async function joinRoom() {
    const roomId = document.getElementById('join-id').value.toUpperCase().trim();
    const name = document.getElementById('student-name').value.trim();
    const errEl = document.getElementById('join-error');
    errEl.classList.add('hidden');

    if (!roomId || !name) {
        errEl.innerText = '⚠️ Please enter room code and nickname.';
        errEl.classList.remove('hidden');
        return;
    }

    setStatus('connecting', 'Loading security token…');

    // Wait for dynamic ice servers first
    const iceServers = await fetchIceServers();
    const peerConfig = createPeerConfig(iceServers);

    setStatus('connecting', 'Connecting…');
    peer = new Peer(undefined, peerConfig);

    peer.on('error', err => {
        console.error('[Student PeerJS]', err);
        if (err.type === 'peer-unavailable') {
            setStatus('error', 'Room not found');
            errEl.innerText = '⚠️ Room not found. Check the code and try again.';
            errEl.classList.remove('hidden');
        } else {
            setStatus('error', 'Connection error');
            errEl.innerText = '⚠️ Connection error: ' + (err.message || err.type);
            errEl.classList.remove('hidden');
        }
    });

    peer.on('open', (id) => {
        myPeerId = id;
        conn = peer.connect(roomId, {
            reliable: true
        });

        const timeout = setTimeout(() => {
            setStatus('error', 'Timeout');
            errEl.innerText = '⚠️ No response from host. Verify room code.';
            errEl.classList.remove('hidden');
        }, 8000);

        conn.on('open', () => {
            clearTimeout(timeout);
            conn.send({
                type: 'join',
                name
            });
            setStatus('connected', 'Connected');
            showView('lobby');
            document.getElementById('display-room-id').innerText = roomId;
            setTimeout(hideStatus, 3000);
        });

        conn.on('data', data => {
            if (data.type === 'start') renderQuestion(data.questionObj, data.num, data.total);
            if (data.type === 'leaderboard') renderLeaderboard(data.standings, data.lastQ, data.stats, data.isFinal, null, data.myAnswer, data.myPoints);
            if (data.type === 'podium') renderPodium(data.standings);
        });

        conn.on('error', err => {
            console.error('[conn error student]', err);
            setStatus('error', 'Connection lost');
        });

        conn.on('close', () => {
            setStatus('error', 'Disconnected');
        });
    });
}

// ── Player list ───────────────────────────────────────────────────────
function updatePlayerList() {
    document.getElementById('player-list').innerHTML = players
        .map(p => `<div class="player-badge">${p.name}</div>`)
        .join('');
}

// ── Quiz flow ─────────────────────────────────────────────────────────
function startQuiz() {
    currentQuestion = 0;
    broadcastQuestion();
}

function broadcastQuestion() {
    if (currentQuestion >= quizData.length) return;
    answersThisRound = 0;
    roundStats = {};

    players.forEach(p => {
        p.answered = false;
        p._lastAnswerIdx = null;
        p._lastPoints = 0;
    });

    const q = quizData[currentQuestion];

    showView('host-monitor');
    document.getElementById('host-question-text').innerText = q.question;
    document.getElementById('host-q-count').innerText = `Question ${currentQuestion + 1} of ${quizData.length}`;
    renderHostAnswers(q.answers);
    updateHostProgress();
    startGlobalTimer();

    connections.forEach(c => {
        const shuffledAnswers = [...q.answers].sort(() => Math.random() - 0.5);
        c.send({
            type: 'start',
            questionObj: {
                ...q,
                answers: shuffledAnswers
            },
            num: currentQuestion + 1,
            total: quizData.length
        });
    });
}

function renderHostAnswers(answers) {
    const grid = document.getElementById('host-answer-grid');
    grid.innerHTML = '';
    const colors = ['bg-rose-600', 'bg-blue-600', 'bg-amber-600', 'bg-emerald-600'];
    const letters = ['A', 'B', 'C', 'D'];
    answers.forEach((ans, i) => {
        const div = document.createElement('div');
        div.className = `host-answer-item ${colors[i % 4]}`;
        div.innerHTML = `<span class="answer-letter">${letters[i]}</span><span>${ans.text}</span>`;
        grid.appendChild(div);
    });
}

function renderQuestion(q, num, total) {
    selectedIdx = null;
    studentLastAnswerIdx = null;
    document.getElementById('confirm-answer-btn').disabled = true;
    showView('quiz');
    document.getElementById('student-q-count').innerText = `Question ${num} of ${total}`;
    document.getElementById('question-text').innerText = q.question;
    const grid = document.getElementById('answer-grid');
    grid.innerHTML = '';
    const colors = ['bg-rose-600', 'bg-blue-600', 'bg-amber-600', 'bg-emerald-600'];

    q.answers.forEach((ans, i) => {
        const btn = document.createElement('button');
        btn.className = `answer-btn ${colors[i % 4]} btn-hover`;
        btn.innerHTML = `${ans.text}`;
        btn.onclick = () => {
            document.querySelectorAll('.answer-btn').forEach(b => b.classList.remove('selected-answer'));
            btn.classList.add('selected-answer');
            selectedIdx = ans.originalIndex;
            document.getElementById('confirm-answer-btn').disabled = false;
        };
        grid.appendChild(btn);
    });
    startGlobalTimer();
}

function confirmSelection() {
    if (selectedIdx === null) return;
    studentLastAnswerIdx = selectedIdx;
    const bonus = parseFloat(document.getElementById('timer').style.width || 0);
    conn.send({
        type: 'answer',
        index: selectedIdx,
        timeBonus: bonus
    });
    showView('wait');
}

// ── Timer ─────────────────────────────────────────────────────────────
function startGlobalTimer() {
    const bars = [document.getElementById('timer'), document.getElementById('host-timer')];
    let start = null;
    if (timerInterval) cancelAnimationFrame(timerInterval);

    function step(timestamp) {
        if (!start) start = timestamp;
        let pct = Math.max(0, 100 - ((timestamp - start) / LIMIT * 100));
        bars.forEach(b => {
            if (b) b.style.width = pct + "%"
        });
        if (timestamp - start < LIMIT) timerInterval = requestAnimationFrame(step);
        else if (isLecturer) finishRound();
    }
    timerInterval = requestAnimationFrame(step);
}

// ── Answer handling ───────────────────────────────────────────────────
function handleAnswer(peerId, originalIndex, bonus) {
    const p = players.find(x => x.id === peerId);
    if (p && !p.answered) {
        p.answered = true;
        answersThisRound++;
        roundStats[originalIndex] = (roundStats[originalIndex] || 0) + 1;
        if (quizData[currentQuestion].answers[originalIndex].correct) {
            p.score += Math.round(100 + bonus * 5);
        }
        updateHostProgress();
        if (answersThisRound >= players.length) {
            cancelAnimationFrame(timerInterval);
            setTimeout(finishRound, 1000);
        }
    }
}

function updateHostProgress() {
    if (isLecturer) document.getElementById('host-progress').innerText = `${answersThisRound} / ${players.length}`;
}

function finishRound() {
    const lastQ = quizData[currentQuestion];
    const stats = roundStats;
    const isFinal = (currentQuestion === quizData.length - 1);

    currentQuestion++;
    const standings = [...players].sort((a, b) => b.score - a.score);

    connections.forEach(c => {
        const player = players.find(p => p.id === c.peer);
        c.send({
            type: 'leaderboard',
            standings,
            lastQ,
            stats,
            isFinal,
            myAnswer: player ? player._lastAnswerIdx : null,
            myPoints: player ? player._lastPoints : 0
        });
    });

    renderLeaderboard(standings, lastQ, stats, isFinal, null, null, null);
}

function finalFinish() {
    const standings = [...players].sort((a, b) => b.score - a.score);
    connections.forEach(c => c.send({
        type: 'podium',
        standings
    }));
    renderPodium(standings);
}

// ── Leaderboard ───────────────────────────────────────────────────────
function renderLeaderboard(standings, lastQ, stats, isFinal, _unused, myAnswerIdx, myPoints) {
    showView('leaderboard');
    document.getElementById('review-q-text').innerText = lastQ.question;
    const reviewAnswers = document.getElementById('review-answers');

    reviewAnswers.innerHTML = lastQ.answers.map((a, idx) => {
        const count = stats[idx] || 0;
        return `
                <div class="review-badge ${a.correct ? 'correct correct-flash' : 'wrong'}">
                    <span>${a.correct ? '✓ ' : ''}${a.text}</span>
                    <span class="count">(${count})</span>
                </div>`;
    }).join('');

    const list = document.getElementById('leaderboard-list');
    list.innerHTML = standings.slice(0, 5).map((p, i) => `
                <div class="glass leaderboard-row ${i === 0 ? 'rank-1' : ''}">
                    <span class="player-name">${i+1}. ${p.name}</span>
                    <span class="player-score">${p.score}</span>
                </div>`).join('');

    const resultBanner = document.getElementById('student-round-result');
    if (!isLecturer) {
        const answeredIdx = (myAnswerIdx !== undefined && myAnswerIdx !== null) ?
            myAnswerIdx :
            studentLastAnswerIdx;

        const answeredAnswer = (answeredIdx !== null && answeredIdx !== undefined) ?
            lastQ.answers.find(a => a.originalIndex === answeredIdx) :
            null;

        const earnedPoints = (myPoints !== undefined && myPoints !== null) ? myPoints : 0;
        const wasCorrect = answeredAnswer ? answeredAnswer.correct : false;

        if (answeredAnswer) {
            resultBanner.className = `round-result-banner animate-slide-in ${wasCorrect ? 'result-correct' : 'result-wrong'}`;
            resultBanner.innerHTML = `
                        <div class="result-icon">${wasCorrect ? '✅' : '❌'}</div>
                        <div class="result-text">
                            <div class="result-label">Your Answer</div>
                            <div class="result-answer-text">${answeredAnswer.text}</div>
                        </div>
                        <div class="result-points">
                            <div class="points-number">${wasCorrect ? '+' + earnedPoints : '0'}</div>
                            <div class="points-label">Points</div>
                        </div>`;
            resultBanner.classList.remove('hidden');
        } else {
            resultBanner.className = 'round-result-banner animate-slide-in result-wrong';
            resultBanner.innerHTML = `
                        <div class="result-icon">⏱️</div>
                        <div class="result-text">
                            <div class="result-label">Your Answer</div>
                            <div class="result-answer-text">No answer</div>
                        </div>
                        <div class="result-points">
                            <div class="points-number">0</div>
                            <div class="points-label">Points</div>
                        </div>`;
            resultBanner.classList.remove('hidden');
        }
    } else {
        resultBanner.classList.add('hidden');
    }

    if (isLecturer) {
        document.getElementById('host-controls').classList.remove('hidden');
        document.getElementById('student-msg').classList.add('hidden');
        if (isFinal) {
            document.getElementById('next-q-btn').classList.add('hidden');
            document.getElementById('show-podium-btn').classList.remove('hidden');
        } else {
            document.getElementById('next-q-btn').classList.remove('hidden');
            document.getElementById('show-podium-btn').classList.add('hidden');
        }
    } else {
        document.getElementById('host-controls').classList.add('hidden');
        document.getElementById('student-msg').classList.remove('hidden');
    }
}

// ── Podium ────────────────────────────────────────────────────────────
function renderPodium(standings) {
    showView('podium');
    confetti({
        particleCount: 200,
        spread: 70,
        origin: {
            y: 0.6
        }
    });
    const container = document.getElementById('podium-container');
    container.innerHTML = '';
    const top3 = standings.slice(0, 3);
    const visualOrder = [1, 0, 2];
    const blocks = {
        0: 'gold',
        1: 'silver',
        2: 'bronze'
    };

    visualOrder.forEach(posIndex => {
        const p = top3[posIndex];
        if (!p) return;
        const div = document.createElement('div');
        div.className = "podium-column";
        div.innerHTML = `
                    <span class="name">${p.name}</span>
                    <div class="podium-block ${blocks[posIndex]}">${posIndex + 1}</div>
                    <span class="score">${p.score}</span>`;
        container.appendChild(div);
    });
}

// ── View switcher ─────────────────────────────────────────────────────
function showView(id) {
    ['start', 'lobby', 'quiz', 'host-monitor', 'wait', 'leaderboard', 'podium'].forEach(v => {
        const el = document.getElementById('view-' + v);
        if (el) el.classList.add('hidden');
    });
    document.getElementById('view-' + id).classList.remove('hidden');
}

// ── Track answer & score in handleAnswer override ─────────────────────
const _origHandleAnswer = handleAnswer;
handleAnswer = function(peerId, originalIndex, bonus) {
    const p = players.find(x => x.id === peerId);
    if (p && !p.answered) {
        p._lastAnswerIdx = originalIndex;
        const isCorrect = quizData[currentQuestion].answers[originalIndex].correct;
        p._lastPoints = isCorrect ? Math.round(100 + bonus * 5) : 0;
    }
    _origHandleAnswer(peerId, originalIndex, bonus);
};

// ── URL param: pre-fill room code ──────────────────────────────────────
window.onload = () => {
    const urlParams = new URLSearchParams(window.location.search);
    const roomFromUrl = urlParams.get('room');
    if (roomFromUrl) {
        document.getElementById('join-id').value = roomFromUrl.toUpperCase();
        document.getElementById('student-name').focus();
    }
};