<script lang="ts">
  import Router from 'svelte-spa-router';
  import HomePage from './routes/home/+page.svelte';
  import LivePage from './routes/live/+page.svelte';
  import RecordingsPage from './routes/recordings/+page.svelte';
  import NewUIPage from './routes/new-ui/+page.svelte';
</script>

<Router
  routes={{
    '/': HomePage,
    '/live': LivePage,
    '/live/:id': LivePage,
    '/recordings': RecordingsPage,
    '/new-ui': NewUIPage,
  }}
/>
