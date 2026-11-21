const express = require('express');
const cron = require('node-cron');
require('dotenv').config();

const { initDB } = require('./database');
const { getPuuidByRiotId, getTftRankByPuuid } = require('./riotService');

const app = express();
app.use(express.json());
app.use(express.static('public'));

let db;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Hạn chót đăng ký: 23:59:59 ngày 01/12/2026 (Giờ Việt Nam)
const REGISTRATION_DEADLINE = new Date('2026-12-01T23:59:59+07:00');
// Thời điểm bắt đầu giải đấu: 00:00:00 ngày 02/12/2026
const TOURNAMENT_START = new Date('2026-12-02T00:00:00+07:00');

// Tự động duyệt những người Admin chưa xếp vào đúng Tier mong muốn khi giải bắt đầu
async function autoFallbackTiersIfNeeded() {
    if (new Date() >= TOURNAMENT_START) {
        const pending = await db.all("SELECT * FROM players WHERE status = 'REGISTERED' OR tier_group = 0");
        if (pending.length > 0) {
            console.log(`[AUTO-FALLBACK] Tự động xếp ${pending.length} tuyển thủ vào Tier mong muốn...`);
            await db.run(`
                UPDATE players 
                SET tier_group = CASE WHEN tier_group = 0 THEN preferred_tier ELSE tier_group END,
                    status = 'ACTIVE',
                    checkpoint_games = games_played
                WHERE status = 'REGISTERED' OR tier_group = 0
            `);
        }
    }
}

async function updateAllPlayers() {
    await autoFallbackTiersIfNeeded();
    console.log(`[${new Date().toLocaleTimeString()}] Đang đồng bộ dữ liệu Riot API...`);
    const players = await db.all("SELECT * FROM players WHERE status IN ('ACTIVE', 'REGISTERED')");

    for (const player of players) {
        try {
            const stats = await getTftRankByPuuid(player.puuid);
            await db.run(
                `UPDATE players 
                 SET current_rank = ?, current_lp = ?, total_points = ?, games_played = ?, last_updated = CURRENT_TIMESTAMP 
                 WHERE id = ?`,
                [stats.current_rank, stats.current_lp, stats.total_points, stats.games_played, player.id]
            );
        } catch (err) {
            console.error(`Lỗi cập nhật ${player.riot_id}:`, err.response?.status || err.message);
        }
        await sleep(300);
    }
}

// 1. Lấy danh sách toàn bộ người chơi
app.get('/api/players', async (req, res) => {
    await autoFallbackTiersIfNeeded();
    const players = await db.all(`
        SELECT *, (games_played - checkpoint_games) AS games_in_round 
        FROM players 
        ORDER BY 
            CASE status WHEN 'ACTIVE' THEN 1 WHEN 'REGISTERED' THEN 2 ELSE 3 END ASC,
            total_points DESC
    `);
    res.json({
        players,
        isRegistrationOpen: new Date() <= REGISTRATION_DEADLINE
    });
});

// 2. Đăng ký công khai kèm Tier mong muốn
app.post('/api/register', async (req, res) => {
    if (new Date() > REGISTRATION_DEADLINE) {
        return res.status(400).json({ error: 'Cổng đăng ký đã đóng sau ngày 01/12/2026!' });
    }

    const { riot_id, preferred_tier } = req.body;
    const prefTierNum = parseInt(preferred_tier);
    if (!riot_id || ![1, 2].includes(prefTierNum)) {
        return res.status(400).json({ error: 'Vui lòng nhập đầy đủ Riot ID và chọn Tier mong muốn!' });
    }

    try {
        const { puuid, formattedName } = await getPuuidByRiotId(riot_id);
        
        const existing = await db.get("SELECT * FROM players WHERE puuid = ?", [puuid]);
        if (existing) {
            return res.status(400).json({ error: `Tài khoản ${formattedName} đã đăng ký trước đó!` });
        }

        const stats = await getTftRankByPuuid(puuid);

        await db.run(
            `INSERT INTO players (riot_id, puuid, preferred_tier, tier_group, status, current_rank, current_lp, total_points, games_played, checkpoint_games)
             VALUES (?, ?, ?, 0, 'REGISTERED', ?, ?, ?, ?, ?)`,
            [formattedName, puuid, prefTierNum, stats.current_rank, stats.current_lp, stats.total_points, stats.games_played, stats.games_played]
        );

        res.json({ message: `Đăng ký thành công ${formattedName} (Nguyện vọng: Tier ${prefTierNum})!` });
    } catch (err) {
        res.status(400).json({ error: 'Không tìm thấy Riot ID này hoặc sai định dạng (VD: TenBan#VN2)' });
    }
});

// 3. Xác thực Admin
app.post('/api/admin/login', (req, res) => {
    if (req.body.secret === process.env.ADMIN_SECRET) {
        res.json({ success: true });
    } else {
        res.status(403).json({ error: 'Mật khẩu Admin không chính xác!' });
    }
});

// 4. Admin duyệt/chỉnh sửa Tier và trạng thái từng người chơi
app.post('/api/admin/edit-player', async (req, res) => {
    const { secret, id, tier_group, status } = req.body;
    if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Không có quyền truy cập' });

    await db.run(
        "UPDATE players SET tier_group = ?, status = ?, checkpoint_games = games_played WHERE id = ?",
        [parseInt(tier_group), status, id]
    );
    res.json({ message: 'Đã cập nhật xếp hạng tuyển thủ!' });
});

// 5. Admin bấm "Chốt & Kích hoạt tất cả" (Nếu người nào chưa duyệt tay thì lấy theo Tier mong muốn)
app.post('/api/admin/activate-all', async (req, res) => {
    if (req.body.secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Không có quyền truy cập' });

    await updateAllPlayers();
    await db.run(`
        UPDATE players 
        SET tier_group = CASE WHEN tier_group = 0 THEN preferred_tier ELSE tier_group END,
            status = 'ACTIVE',
            checkpoint_games = games_played
        WHERE status = 'REGISTERED'
    `);
    res.json({ message: 'Đã kích hoạt giải đấu! Tất cả tuyển thủ chưa duyệt tay đã được xếp vào Tier mong muốn.' });
});

// 6. Xóa người chơi
app.delete('/api/admin/delete-player/:id', async (req, res) => {
    if (req.body.secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Không có quyền truy cập' });
    await db.run("DELETE FROM players WHERE id = ?", [req.params.id]);
    res.json({ message: 'Đã xóa tuyển thủ khỏi danh sách.' });
});

// 7. Ép cập nhật dữ liệu Riot
app.post('/api/admin/force-update', async (req, res) => {
    if (req.body.secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Không có quyền truy cập' });
    await updateAllPlayers();
    res.json({ message: 'Đã cập nhật xong dữ liệu mới nhất từ Riot!' });
});

// 8. Chốt sổ thanh lọc cuối ngày (Từ 12/12 đến 25/12)
app.post('/api/admin/eliminate', async (req, res) => {
    const { secret, round_number, min_games, eliminate_count } = req.body;
    if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Không có quyền truy cập' });

    await updateAllPlayers();
    const eliminatedList = [];

    for (const tier of [1, 2]) {
        const activeInTier = await db.all(
            "SELECT * FROM players WHERE status = 'ACTIVE' AND tier_group = ? ORDER BY total_points DESC",
            [tier]
        );

        let eliminatedCount = 0;

        for (const p of activeInTier) {
            const gamesPlayedInRound = p.games_played - p.checkpoint_games;
            if (gamesPlayedInRound < min_games) {
                await db.run("UPDATE players SET status = 'ELIMINATED', eliminated_round = ? WHERE id = ?", [round_number, p.id]);
                eliminatedList.push(`${p.riot_id} (Tier ${tier} - Thiếu trận: ${gamesPlayedInRound}/${min_games})`);
                eliminatedCount++;
            }
        }

        const remaining = await db.all(
            "SELECT * FROM players WHERE status = 'ACTIVE' AND tier_group = ? ORDER BY total_points ASC",
            [tier]
        );

        const needMore = eliminate_count - eliminatedCount;
        for (let i = 0; i < needMore && i < remaining.length; i++) {
            const p = remaining[i];
            await db.run("UPDATE players SET status = 'ELIMINATED', eliminated_round = ? WHERE id = ?", [round_number, p.id]);
            eliminatedList.push(`${p.riot_id} (Tier ${tier} - Hạng chót: ${p.current_rank} ${p.current_lp} LP)`);
        }
    }

    await db.run("UPDATE players SET checkpoint_games = games_played WHERE status = 'ACTIVE'");
    res.json({ message: `Hoàn tất chốt sổ Vòng ${round_number}`, eliminated: eliminatedList });
});

// Cron Job tự động quét mỗi 15 phút
cron.schedule('*/15 * * * *', () => {
    updateAllPlayers();
});

initDB().then(database => {
    db = database;
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Prismatic Tour Server chạy tại: http://localhost:${PORT}`));
});