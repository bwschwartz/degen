import { useEffect, useState } from 'react'
import { Alert, Box, CircularProgress, Stack, Typography } from '@mui/material'
import { BarChart } from '@mui/x-charts/BarChart'

export interface GameLogGame {
  game_id: string
  date: string
  home: boolean
  opponent: string
  team_points: number | null
  opponent_points: number | null
  points: number | null
  rebounds: number | null
  minutes: number | null
}

export interface GameLog {
  id: string
  full_name: string
  team: string
  season: { year: number; type: string }
  games: GameLogGame[]
}

// Validated data-series blue (dataviz slot 1); identity comes from each
// chart's title, so all three charts share the one hue.
const SERIES_COLOR = '#2a78d6'

// Module-level so collapsing (which unmounts the panel) keeps the data.
const gameLogCache = new Map<string, GameLog>()

function gameLabel(game: GameLogGame) {
  return new Date(game.date).toLocaleDateString(undefined, {
    month: 'numeric',
    day: 'numeric',
  })
}

function gameContext(game: GameLogGame) {
  const where = game.home ? 'vs' : '@'
  if (game.team_points == null || game.opponent_points == null) {
    return `${where} ${game.opponent}`
  }
  const result = game.team_points > game.opponent_points ? 'W' : 'L'
  return `${where} ${game.opponent} · ${result} ${game.team_points}-${game.opponent_points}`
}

function StatChart({
  title,
  unit,
  games,
  values,
}: {
  title: string
  unit: string
  games: GameLogGame[]
  values: (number | null)[]
}) {
  return (
    <Box sx={{ flex: '1 1 260px', minWidth: 240 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
        {title}
      </Typography>
      <BarChart
        height={170}
        xAxis={[
          {
            scaleType: 'band',
            data: games.map(gameLabel),
            categoryGapRatio: 0.5,
            tickLabelStyle: { fontSize: 10 },
          },
        ]}
        yAxis={[{ tickLabelStyle: { fontSize: 10 } }]}
        series={[
          {
            data: values,
            color: SERIES_COLOR,
            label: title,
            valueFormatter: (value, { dataIndex }) =>
              `${value ?? '—'} ${unit} · ${gameContext(games[dataIndex])}`,
          },
        ]}
        hideLegend
        grid={{ horizontal: true }}
        borderRadius={4}
        margin={{ left: 8, right: 8, top: 12, bottom: 0 }}
      />
    </Box>
  )
}

export default function GameLogPanel({ playerId }: { playerId: string }) {
  const [log, setLog] = useState<GameLog | null>(gameLogCache.get(playerId) ?? null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const cached = gameLogCache.get(playerId)
    if (cached) {
      setLog(cached)
      setError(null)
      return
    }
    setLog(null)
    setError(null)
    let cancelled = false
    fetch(`/api/players/${playerId}/gamelog`)
      .then(async (resp) => {
        const data = await resp.json()
        if (!resp.ok) throw new Error(data.error ?? `Request failed (${resp.status})`)
        gameLogCache.set(playerId, data)
        if (!cancelled) setLog(data)
      })
      .catch((err) => {
        if (!cancelled) setError(String(err))
      })
    return () => {
      cancelled = true
    }
  }, [playerId])

  if (error) {
    return (
      <Alert severity="error" sx={{ my: 2 }}>
        {error}
      </Alert>
    )
  }

  if (!log) {
    return (
      <Stack sx={{ alignItems: 'center', py: 4 }} spacing={2}>
        <CircularProgress size={28} />
        <Typography variant="body2" color="text.secondary">
          Fetching game logs — the first load for a team can take ~20 seconds…
        </Typography>
      </Stack>
    )
  }

  if (log.games.length === 0) {
    return (
      <Typography color="text.secondary" sx={{ py: 3 }} align="center">
        No completed games found for this player.
      </Typography>
    )
  }

  return (
    <Box sx={{ py: 2 }}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Last {log.games.length} games · {log.team} · {log.season.year}
      </Typography>
      <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 2 }}>
        <StatChart
          title="Points"
          unit="pts"
          games={log.games}
          values={log.games.map((g) => g.points)}
        />
        <StatChart
          title="Rebounds"
          unit="reb"
          games={log.games}
          values={log.games.map((g) => g.rebounds)}
        />
        <StatChart
          title="Minutes"
          unit="min"
          games={log.games}
          values={log.games.map((g) => g.minutes)}
        />
      </Stack>
    </Box>
  )
}
