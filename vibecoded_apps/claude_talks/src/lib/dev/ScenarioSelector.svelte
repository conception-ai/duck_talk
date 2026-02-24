<script lang="ts" generics="T">
  /**
   * Reusable scenario selector for UI prototyping.
   * Renders a floating dropdown in the top-right corner.
   * Generic over the scenario state shape.
   */

  interface Scenario {
    name: string;
    description: string;
    state: T;
  }

  let { scenarios, current = $bindable() }: {
    scenarios: Scenario[];
    current: Scenario;
  } = $props();
</script>

<div class="scenario-selector">
  <select bind:value={current}>
    {#each scenarios as s}
      <option value={s}>{s.name}</option>
    {/each}
  </select>
  <p class="desc">{current.description}</p>
</div>

<style>
  .scenario-selector {
    position: fixed;
    top: 0.5rem;
    right: 0.5rem;
    z-index: 999;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.6rem;
    background: rgba(255, 255, 255, 0.95);
    backdrop-filter: blur(8px);
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
    font-family: system-ui, sans-serif;
  }

  select {
    font-size: 0.8rem;
    font-weight: 600;
    border: none;
    background: none;
    cursor: pointer;
    padding: 0.15rem 0;
    color: #374151;
  }

  .desc {
    margin: 0;
    font-size: 0.7rem;
    color: #9ca3af;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
