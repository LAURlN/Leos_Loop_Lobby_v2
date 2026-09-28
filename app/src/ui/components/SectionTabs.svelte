<!--
  Browser-like section tabs in the top bar:
  - "Song" tab on the left: full song view with all sections in order
  - Tab selection, inline renaming (double click / edit button)
  - Drag-and-drop reordering + accessible ← / → buttons
  - Section deletion ('×' with confirmation when containing loops)
  - Add section button ('+')
  - Multiplayer presence badges showing peers in each section
-->
<script lang="ts">
  import { tick } from 'svelte';
  import { lobby } from '../../state/lobby.svelte';

  let editingId = $state<string | null>(null);
  let editInputVal = $state('');
  let editInputEl = $state<HTMLInputElement | null>(null);
  let confirmDeleteId = $state<string | null>(null);
  let draggedId = $state<string | null>(null);
  let dragOverIndex = $state<number | null>(null);

  const sections = $derived(lobby.snapshot.sections);
  const activeSectionId = $derived(lobby.activeSection?.id ?? null);

  async function startEditing(id: string, currentName: string, event?: Event) {
    event?.stopPropagation();
    editingId = id;
    editInputVal = currentName;
    confirmDeleteId = null;
    await tick();
    editInputEl?.focus();
    editInputEl?.select();
  }

  function saveEditing(id: string) {
    if (editingId !== id) return;
    const clean = editInputVal.trim();
    if (clean) lobby.renameSection(id, clean);
    editingId = null;
  }

  function handleEditKey(event: KeyboardEvent, id: string) {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveEditing(id);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      editingId = null;
    }
  }

  function handleDelete(id: string, event: Event) {
    event.stopPropagation();
    const tracksInSection = lobby.snapshot.tracks.filter((t) => t.sectionId === id);
    if (tracksInSection.length === 0 || confirmDeleteId === id) {
      lobby.deleteSection(id);
      confirmDeleteId = null;
    } else {
      confirmDeleteId = id;
    }
  }

  // Clear delete confirmation on blur/click away
  $effect(() => {
    void activeSectionId;
    confirmDeleteId = null;
  });

  // Drag and drop handlers
  function ondragstart(event: DragEvent, id: string) {
    draggedId = id;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', id);
    }
  }

  function ondragover(event: DragEvent, index: number) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    dragOverIndex = index;
  }

  function ondragleave(index: number) {
    if (dragOverIndex === index) dragOverIndex = null;
  }

  function ondrop(event: DragEvent, targetIndex: number) {
    event.preventDefault();
    if (draggedId) {
      lobby.reorderSection(draggedId, targetIndex);
    }
    draggedId = null;
    dragOverIndex = null;
  }

  function ondragend() {
    draggedId = null;
    dragOverIndex = null;
  }
</script>

<nav class="tabs-bar" aria-label="Sections">
  <div class="tabs-list" role="tablist">
    <div class="tab-wrapper">
      <div
        class="tab song-tab"
        class:active={lobby.songView}
        role="tab"
        aria-selected={lobby.songView}
        tabindex="0"
        title="Full song: all sections in order"
        onclick={() => lobby.openSongView()}
        onkeydown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            lobby.openSongView();
          }
        }}
      >
        <span aria-hidden="true">♫</span>
        <span class="tab-title">Song</span>
      </div>
    </div>
    <span class="song-divider" aria-hidden="true"></span>
    {#each sections as sec, index (sec.id)}
      {@const isActive = !lobby.songView && sec.id === activeSectionId}
      {@const peers = lobby.peersInSection(sec.id)}
      {@const isEditing = editingId === sec.id}
      {@const isConfirmDelete = confirmDeleteId === sec.id}

      <div
        class="tab-wrapper"
        class:drag-over={dragOverIndex === index}
        role="presentation"
        ondragover={(e) => ondragover(e, index)}
        ondragleave={() => ondragleave(index)}
        ondrop={(e) => ondrop(e, index)}
      >
        <div
          class="tab"
          class:active={isActive}
          role="tab"
          aria-selected={isActive}
          tabindex="0"
          draggable={!isEditing}
          ondragstart={(e) => ondragstart(e, sec.id)}
          ondragend={ondragend}
          onclick={() => {
            if (!isEditing) lobby.selectSection(sec.id);
          }}
          ondblclick={(e) => startEditing(sec.id, sec.name, e)}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              if (!isEditing) lobby.selectSection(sec.id);
            } else if (e.key === 'F2') {
              startEditing(sec.id, sec.name, e);
            }
          }}
        >
          {#if isEditing}
            <input
              bind:this={editInputEl}
              type="text"
              class="tab-edit-input"
              bind:value={editInputVal}
              maxlength="40"
              onblur={() => saveEditing(sec.id)}
              onkeydown={(e) => handleEditKey(e, sec.id)}
              onclick={(e) => e.stopPropagation()}
            />
          {:else}
            <span class="tab-title" title="Double-click to rename">
              {sec.name}
            </span>
          {/if}

          <!-- Peer presence indicator in this section -->
          {#if peers.length > 0}
            <div class="peer-badges" title={`Active in this section: ${peers.map((p) => p.name).join(', ')}`}>
              {#each peers.slice(0, 3) as peer (peer.peerId)}
                <span class="peer-dot" title={peer.name}>{peer.name[0]?.toUpperCase() ?? '•'}</span>
              {/each}
              {#if peers.length > 3}
                <span class="peer-more">+{peers.length - 3}</span>
              {/if}
            </div>
          {/if}

          <!-- Reorder & Action Controls -->
          <div class="tab-controls" onclick={(e) => e.stopPropagation()} role="presentation">
            {#if !isEditing}
              <button
                type="button"
                class="ctrl-btn edit"
                title="Rename section"
                aria-label="Rename section"
                onclick={(e) => startEditing(sec.id, sec.name, e)}
              >
                ✎
              </button>
              <button
                type="button"
                class="ctrl-btn arrow"
                title="Move left"
                aria-label="Move section left"
                disabled={index === 0}
                onclick={() => lobby.moveSection(sec.id, 'left')}
              >
                ‹
              </button>
              <button
                type="button"
                class="ctrl-btn arrow"
                title="Move right"
                aria-label="Move section right"
                disabled={index === sections.length - 1}
                onclick={() => lobby.moveSection(sec.id, 'right')}
              >
                ›
              </button>
            {/if}

            {#if sections.length > 1}
              <button
                type="button"
                class="ctrl-btn delete"
                class:sure={isConfirmDelete}
                title={isConfirmDelete ? 'Click again to confirm delete' : 'Delete section'}
                aria-label="Delete section"
                onclick={(e) => handleDelete(sec.id, e)}
              >
                {isConfirmDelete ? 'Sure?' : '✕'}
              </button>
            {/if}
          </div>
        </div>
      </div>
    {/each}

    <!-- Add Section Button -->
    <button
      type="button"
      class="add-section-btn"
      title="Create new section"
      aria-label="Create new section"
      onclick={() => lobby.createSection()}
    >
      <span class="plus-icon">+</span>
    </button>
  </div>
</nav>

<style>
  .tabs-bar {
    display: flex;
    align-items: center;
    overflow-x: auto;
    scrollbar-width: thin;
    padding: 0 4px;
    user-select: none;
    background: transparent;
  }
  .tabs-bar::-webkit-scrollbar {
    height: 4px;
  }
  .tabs-bar::-webkit-scrollbar-thumb {
    background: var(--border);
    border-radius: 2px;
  }

  .tabs-list {
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: 38px;
    padding: 4px 0;
  }

  .tab-wrapper {
    position: relative;
    display: flex;
    align-items: center;
    border-radius: var(--radius-sm);
    transition: transform 0.15s;
  }
  .tab-wrapper.drag-over {
    outline: 2px dashed var(--accent);
    outline-offset: 2px;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    min-height: 34px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--muted);
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    position: relative;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .tab:hover {
    background: var(--surface-3);
    color: var(--text);
  }
  .tab.active {
    background: var(--surface-3);
    border-color: var(--accent);
    color: var(--text);
    box-shadow: 0 2px 8px rgb(0 0 0 / 0.3), inset 0 -2px 0 var(--accent);
  }

  .song-tab {
    gap: 6px;
  }
  .song-divider {
    width: 1px;
    height: 22px;
    margin: 0 4px;
    background: var(--border);
    flex: none;
  }

  .tab-title {
    display: inline-block;
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 2px 4px;
    border-radius: 4px;
  }
  .tab-title:hover {
    background: rgb(255 255 255 / 0.05);
  }

  .tab-edit-input {
    font: inherit;
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--accent);
    border-radius: 4px;
    padding: 2px 6px;
    width: 90px;
    min-height: 24px;
    outline: none;
  }

  .peer-badges {
    display: flex;
    align-items: center;
    gap: 2px;
    margin-left: 2px;
  }
  .peer-dot {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--accent-2);
    color: #0b0f19;
    font-size: 10px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.4);
  }
  .peer-more {
    font-size: 10px;
    color: var(--muted);
    font-weight: 700;
  }

  .tab-controls {
    display: flex;
    align-items: center;
    gap: 2px;
    opacity: 0.6;
    transition: opacity 0.15s;
  }
  .tab:hover .tab-controls,
  .tab.active .tab-controls {
    opacity: 1;
  }

  .ctrl-btn {
    min-height: 22px;
    height: 22px;
    padding: 0 4px;
    background: transparent;
    border: none;
    border-radius: 4px;
    font-size: 12px;
    color: var(--muted);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .ctrl-btn:hover:not(:disabled) {
    background: var(--surface);
    color: var(--text);
  }
  .ctrl-btn.arrow {
    font-size: 14px;
    padding: 0 3px;
    line-height: 1;
  }
  .ctrl-btn.delete:hover:not(:disabled) {
    color: var(--danger);
    background: rgb(255 92 112 / 0.15);
  }
  .ctrl-btn.delete.sure {
    color: var(--danger);
    background: rgb(255 92 112 / 0.25);
    font-size: 10px;
    font-weight: 700;
    padding: 0 6px;
  }

  .add-section-btn {
    min-height: 34px;
    height: 34px;
    width: 34px;
    padding: 0;
    background: transparent;
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--muted);
    transition: color 0.15s, border-color 0.15s, background 0.15s;
  }
  .add-section-btn:hover {
    color: var(--accent);
    border-color: var(--accent);
    background: rgb(120 239 202 / 0.08);
  }
  .plus-icon {
    font-size: 20px;
    line-height: 1;
  }
</style>
