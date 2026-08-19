import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Autocomplete,
  Box,
  CircularProgress,
  Container,
  CssBaseline,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Button,
  Fab,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  ThemeProvider,
  Tooltip,
  Typography,
  createTheme,
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined'

const theme = createTheme({
  palette: {
    primary: { main: '#e56020' }, // WNBA orange
  },
})

interface SearchPlayer {
  id: string
  full_name: string
  position: string
  jersey_number: string
  team: string
}

interface PlayerStats {
  id: string
  full_name: string
  position: string
  team: string | null
  season: { year: number; type: string } | null
  games_played: number | null
  points: number | null
  rebounds: number | null
  minutes: number | null
}

interface Row {
  id: string
  full_name: string
  status: 'loading' | 'ready' | 'error'
  stats?: PlayerStats
  error?: string
}

const STORAGE_KEY = 'wnba-tracked-players'

function loadSavedPlayers(): { id: string; full_name: string }[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
  } catch {
    return []
  }
}

function formatStat(value: number | null | undefined) {
  return value == null ? '—' : value.toFixed(1)
}

function App() {
  const [rows, setRows] = useState<Row[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<SearchPlayer[]>([])
  const [searching, setSearching] = useState(false)
  const [indexBuilding, setIndexBuilding] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [retryTick, setRetryTick] = useState(0)

  const fetchStats = useCallback(async (id: string) => {
    try {
      const resp = await fetch(`/api/players/${id}/stats`)
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error ?? `Request failed (${resp.status})`)
      setRows((prev) =>
        prev.map((r) => (r.id === id ? { ...r, status: 'ready', stats: data } : r)),
      )
    } catch (err) {
      setRows((prev) =>
        prev.map((r) =>
          r.id === id ? { ...r, status: 'error', error: String(err) } : r,
        ),
      )
    }
  }, [])

  // Restore saved players on first mount (guarded against StrictMode re-run).
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current) return
    restored.current = true
    const saved = loadSavedPlayers()
    if (saved.length === 0) return
    setRows(saved.map((p) => ({ ...p, status: 'loading' as const })))
    saved.forEach((p) => void fetchStats(p.id))
  }, [fetchStats])

  useEffect(() => {
    if (!restored.current) return
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(rows.map(({ id, full_name }) => ({ id, full_name }))),
    )
  }, [rows])

  // Server-side player search, debounced.
  useEffect(() => {
    if (!dialogOpen) return
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setOptions([])
      setSearching(false)
      return
    }
    setSearching(true)
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const resp = await fetch(
          `/api/players/search?q=${encodeURIComponent(trimmed)}`,
          { signal: controller.signal },
        )
        const data = await resp.json()
        if (!resp.ok) throw new Error(data.error ?? `Request failed (${resp.status})`)
        setSearchError(null)
        if (data.building) {
          // Rosters still loading server-side; poll again shortly.
          setIndexBuilding(true)
          setTimeout(() => setRetryTick((t) => t + 1), 2000)
          return
        }
        setIndexBuilding(false)
        setOptions(data.players)
        setSearching(false)
      } catch (err) {
        if (controller.signal.aborted) return
        setSearching(false)
        setIndexBuilding(false)
        setSearchError(String(err))
      }
    }, 300)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [query, dialogOpen, retryTick])

  const addPlayer = (player: SearchPlayer | null) => {
    if (!player) return
    setDialogOpen(false)
    setQuery('')
    setOptions([])
    if (rows.some((r) => r.id === player.id)) return
    setRows((prev) => [
      ...prev,
      { id: player.id, full_name: player.full_name, status: 'loading' },
    ])
    void fetchStats(player.id)
  }

  const removePlayer = (id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id))
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Container maxWidth="md" sx={{ py: 6, textAlign: 'left' }}>
        <Stack
          direction="row"
          sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 3 }}
        >
          <Box>
            <Typography variant="h4" component="h1" sx={{ fontWeight: 600 }}>
              WNBA Player Stats
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Per-game averages, current season
            </Typography>
          </Box>
          <Tooltip title="Add a player">
            <Fab color="primary" aria-label="add player" onClick={() => setDialogOpen(true)}>
              <AddIcon />
            </Fab>
          </Tooltip>
        </Stack>

        <TableContainer component={Paper}>
          <Table aria-label="player statistics">
            <TableHead>
              <TableRow>
                <TableCell>Player</TableCell>
                <TableCell align="right">Points</TableCell>
                <TableCell align="right">Rebounds</TableCell>
                <TableCell align="right">Minutes</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} align="center" sx={{ py: 6 }}>
                    <Typography color="text.secondary">
                      No players yet — hit the + button to search for players.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
              {rows.map((row) => (
                <TableRow key={row.id} hover>
                  <TableCell>
                    <Typography sx={{ fontWeight: 500 }}>{row.full_name}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {row.status === 'loading' && 'Loading…'}
                      {row.status === 'error' && (row.error ?? 'Failed to load stats')}
                      {row.status === 'ready' &&
                        row.stats &&
                        [
                          row.stats.team,
                          row.stats.position,
                          row.stats.games_played != null
                            ? `${row.stats.games_played} GP`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                    </Typography>
                  </TableCell>
                  {row.status === 'loading' ? (
                    <TableCell colSpan={3} align="center">
                      <CircularProgress size={20} />
                    </TableCell>
                  ) : (
                    <>
                      <TableCell align="right">{formatStat(row.stats?.points)}</TableCell>
                      <TableCell align="right">{formatStat(row.stats?.rebounds)}</TableCell>
                      <TableCell align="right">{formatStat(row.stats?.minutes)}</TableCell>
                    </>
                  )}
                  <TableCell align="right">
                    <Tooltip title="Remove">
                      <IconButton
                        size="small"
                        aria-label={`remove ${row.full_name}`}
                        onClick={() => removePlayer(row.id)}
                      >
                        <DeleteOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Container>

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Add a player</DialogTitle>
        <DialogContent>
          <Autocomplete
            options={options}
            filterOptions={(x) => x}
            getOptionLabel={(option) => option.full_name}
            isOptionEqualToValue={(a, b) => a.id === b.id}
            loading={searching}
            loadingText={indexBuilding ? 'Loading league rosters…' : 'Searching…'}
            noOptionsText={
              query.trim().length < 2 ? 'Type at least 2 letters' : 'No players found'
            }
            onInputChange={(_e, value) => setQuery(value)}
            onChange={(_e, value) => addPlayer(value)}
            value={null}
            blurOnSelect
            renderOption={(props, option) => (
              <Box component="li" {...props} key={option.id}>
                <Box>
                  <Typography>{option.full_name}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {[option.team, option.position, option.jersey_number && `#${option.jersey_number}`]
                      .filter(Boolean)
                      .join(' · ')}
                  </Typography>
                </Box>
              </Box>
            )}
            renderInput={(params) => (
              <TextField
                {...params}
                autoFocus
                margin="dense"
                label="Search players"
                error={Boolean(searchError)}
                helperText={searchError ?? undefined}
              />
            )}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
        </DialogActions>
      </Dialog>
    </ThemeProvider>
  )
}

export default App
