const samplePlayer = {
  id: 145,
  login: "ZLO",
  country: "RU",
  joinedAt: "2014-08-12T12:00:00Z",
  ratings: {
    global: 2112,
    ladder1v1: 1988,
    tmm2v2: 2056
  }
};

const sampleGames = [
  {
    id: 18823001,
    startedAt: "2026-04-29T20:10:00Z",
    endedAt: "2026-04-29T20:45:00Z",
    durationMinutes: 35,
    mapName: "Open Palms",
    queueLabel: "Ladder 1v1",
    queueCategory: "ladder_1v1",
    ratingType: "ladder1v1",
    playerOutcome: "WIN",
    replayId: 18823001,
    replayUrl: "https://replay.faforever.com/18823001",
    teammates: [],
    opponents: [{ login: "Tagada", rating: 1944 }]
  },
  {
    id: 18822912,
    startedAt: "2026-04-28T18:15:00Z",
    endedAt: "2026-04-28T19:02:00Z",
    durationMinutes: 47,
    mapName: "Canis River",
    queueLabel: "Global 4v4",
    queueCategory: "global",
    ratingType: "global",
    playerOutcome: "LOSS",
    replayId: 18822912,
    replayUrl: "https://replay.faforever.com/18822912",
    teammates: [{ login: "Mizer", rating: 1870 }, { login: "Torpid", rating: 1801 }, { login: "Ari", rating: 1752 }],
    opponents: [{ login: "Blodir", rating: 1910 }, { login: "Marlo", rating: 1745 }, { login: "North", rating: 1661 }, { login: "Dante", rating: 2010 }]
  },
  {
    id: 18822402,
    startedAt: "2026-04-27T17:00:00Z",
    endedAt: "2026-04-27T17:34:00Z",
    durationMinutes: 34,
    mapName: "Open Palms",
    queueLabel: "Ladder 1v1",
    queueCategory: "ladder_1v1",
    ratingType: "ladder1v1",
    playerOutcome: "WIN",
    replayId: 18822402,
    replayUrl: "https://replay.faforever.com/18822402",
    teammates: [],
    opponents: [{ login: "Tagada", rating: 1951 }]
  },
  {
    id: 18822007,
    startedAt: "2026-04-26T13:12:00Z",
    endedAt: "2026-04-26T13:44:00Z",
    durationMinutes: 32,
    mapName: "Crossfire Canal",
    queueLabel: "TMM 2v2",
    queueCategory: "tmm_2v2",
    ratingType: "tmm2v2",
    playerOutcome: "WIN",
    replayId: 18822007,
    replayUrl: "https://replay.faforever.com/18822007",
    teammates: [{ login: "Mizer", rating: 1862 }],
    opponents: [{ login: "North", rating: 1690 }, { login: "Dante", rating: 2003 }]
  },
  {
    id: 18821900,
    startedAt: "2026-04-25T21:30:00Z",
    endedAt: "2026-04-25T22:26:00Z",
    durationMinutes: 56,
    mapName: "Seton's Clutch",
    queueLabel: "Global 4v4",
    queueCategory: "global",
    ratingType: "global",
    playerOutcome: "WIN",
    replayId: 18821900,
    replayUrl: "https://replay.faforever.com/18821900",
    teammates: [{ login: "Ari", rating: 1758 }, { login: "Mizer", rating: 1869 }, { login: "Stone", rating: 1711 }],
    opponents: [{ login: "Vindex", rating: 1811 }, { login: "Dante", rating: 2004 }, { login: "Flak", rating: 1684 }, { login: "North", rating: 1674 }]
  },
  {
    id: 18821430,
    startedAt: "2026-04-24T16:05:00Z",
    endedAt: "2026-04-24T16:50:00Z",
    durationMinutes: 45,
    mapName: "Crossfire Canal",
    queueLabel: "TMM 2v2",
    queueCategory: "tmm_2v2",
    ratingType: "tmm2v2",
    playerOutcome: "LOSS",
    replayId: 18821430,
    replayUrl: "https://replay.faforever.com/18821430",
    teammates: [{ login: "Mizer", rating: 1859 }],
    opponents: [{ login: "Marlo", rating: 1762 }, { login: "Blodir", rating: 1906 }]
  },
  {
    id: 18821111,
    startedAt: "2026-04-23T15:15:00Z",
    endedAt: "2026-04-23T16:04:00Z",
    durationMinutes: 49,
    mapName: "Hilly Plateau",
    queueLabel: "Ladder 1v1",
    queueCategory: "ladder_1v1",
    ratingType: "ladder1v1",
    playerOutcome: "WIN",
    replayId: 18821111,
    replayUrl: "https://replay.faforever.com/18821111",
    teammates: [],
    opponents: [{ login: "Rik", rating: 1830 }]
  },
  {
    id: 18820410,
    startedAt: "2026-04-22T18:22:00Z",
    endedAt: "2026-04-22T19:00:00Z",
    durationMinutes: 38,
    mapName: "Seton's Clutch",
    queueLabel: "Global 4v4",
    queueCategory: "global",
    ratingType: "global",
    playerOutcome: "WIN",
    replayId: 18820410,
    replayUrl: "https://replay.faforever.com/18820410",
    teammates: [{ login: "Ari", rating: 1755 }, { login: "Stone", rating: 1709 }, { login: "Mizer", rating: 1864 }],
    opponents: [{ login: "Tagada", rating: 1948 }, { login: "North", rating: 1669 }, { login: "Flak", rating: 1680 }, { login: "Dante", rating: 1997 }]
  },
  {
    id: 18820120,
    startedAt: "2026-04-21T19:30:00Z",
    endedAt: "2026-04-21T20:02:00Z",
    durationMinutes: 32,
    mapName: "Open Palms",
    queueLabel: "Ladder 1v1",
    queueCategory: "ladder_1v1",
    ratingType: "ladder1v1",
    playerOutcome: "LOSS",
    replayId: 18820120,
    replayUrl: "https://replay.faforever.com/18820120",
    teammates: [],
    opponents: [{ login: "Vindex", rating: 1804 }]
  },
  {
    id: 18819877,
    startedAt: "2026-04-20T21:44:00Z",
    endedAt: "2026-04-20T22:31:00Z",
    durationMinutes: 47,
    mapName: "Canis River",
    queueLabel: "Global 4v4",
    queueCategory: "global",
    ratingType: "global",
    playerOutcome: "WIN",
    replayId: 18819877,
    replayUrl: "https://replay.faforever.com/18819877",
    teammates: [{ login: "Torpid", rating: 1795 }, { login: "Ari", rating: 1748 }, { login: "Mizer", rating: 1858 }],
    opponents: [{ login: "Marlo", rating: 1758 }, { login: "North", rating: 1665 }, { login: "Flak", rating: 1673 }, { login: "Rik", rating: 1824 }]
  }
];

function createSampleProvider() {
  return {
    async getStatus() {
      return {
        ok: true,
        label: "Ready",
        detail: "Bundled sample data is available immediately."
      };
    },

    async getPlayerReport(playerRef) {
      if (String(playerRef).toLowerCase() !== samplePlayer.login.toLowerCase()) {
        const error = new Error(`No bundled sample exists for "${playerRef}". Try "ZLO".`);
        error.statusCode = 404;
        throw error;
      }

      return {
        player: samplePlayer,
        games: sampleGames,
        meta: {
          source: "sample",
          note: "This is a seeded dataset so the analytics UI can be built and tested even while FAF access is blocked."
        }
      };
    }
  };
}

module.exports = {
  createSampleProvider
};
