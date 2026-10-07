<script setup lang="ts">
defineProps<{
  title: string
  description: string
}>()
</script>

<template>
  <header class="page-header">
    <div>
      <h2>{{ title }}</h2>
      <p>{{ description }}</p>
    </div>
    <div class="header-actions">
      <slot name="actions" />
    </div>
  </header>
</template>
