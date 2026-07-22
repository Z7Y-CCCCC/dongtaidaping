<template>
    <RouterView v-slot="{ Component, route }">
        <Transition name="route-fade" mode="out-in">
            <KeepAlive include="AdminPanel">
                <component
                    :is="Component"
                    :key="route.meta.keepAlive ? route.name : route.fullPath"
                />
            </KeepAlive>
        </Transition>
    </RouterView>
</template>
