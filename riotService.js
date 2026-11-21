const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.RIOT_API_KEY;
const HEADERS = { 'X-Riot-Token': API_KEY };

const TIER_BASE_POINTS = {
    'IRON': 0, 'BRONZE': 400, 'SILVER': 800, 'GOLD': 1200,
    'PLATINUM': 1600, 'EMERALD': 2000, 'DIAMOND': 2400,
    'MASTER': 2800, 'GRANDMASTER': 2800, 'CHALLENGER': 2800
};

const RANK_BONUS = { 'IV': 0, 'III': 100, 'II': 200, 'I': 300 };

function calculatePoints(tier, rank, lp) {
    if (!tier || TIER_BASE_POINTS[tier] === undefined) return 0;
    if (['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(tier)) {
        return TIER_BASE_POINTS[tier] + lp;
    }
    return TIER_BASE_POINTS[tier] + (RANK_BONUS[rank] || 0) + lp;
}

async function getPuuidByRiotId(riotId) {
    const [gameName, tagLine] = riotId.split('#');
    if (!gameName || !tagLine) throw new Error('Sai định dạng Riot ID (Ví dụ: TenBan#VN2)');

    const url = `https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName.trim())}/${encodeURIComponent(tagLine.trim())}`;
    const response = await axios.get(url, { headers: HEADERS });
    return {
        puuid: response.data.puuid,
        formattedName: `${response.data.gameName}#${response.data.tagLine}`
    };
}

async function getTftRankByPuuid(puuid) {
    const url = `https://vn2.api.riotgames.com/tft/league/v1/by-puuid/${puuid}`;
    const response = await axios.get(url, { headers: HEADERS });
    const rankedData = response.data.find(entry => entry.queueType === 'RANKED_TFT');

    if (!rankedData) {
        return { current_rank: 'UNRANKED', current_lp: 0, total_points: 0, games_played: 0 };
    }

    const totalPoints = calculatePoints(rankedData.tier, rankedData.rank, rankedData.leaguePoints);
    const displayRank = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(rankedData.tier)
        ? rankedData.tier
        : `${rankedData.tier} ${rankedData.rank}`;

    return {
        current_rank: displayRank,
        current_lp: rankedData.leaguePoints,
        total_points: totalPoints,
        games_played: rankedData.wins + rankedData.losses
    };
}

module.exports = { getPuuidByRiotId, getTftRankByPuuid };