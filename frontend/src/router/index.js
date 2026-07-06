import { createRouter, createWebHistory } from 'vue-router'
import App from '../App.vue'

const routes = [
    { path: '/', component: App, meta: { title: '热处理数字孪生大屏' } },
    { path: '/admin', component: () => import('../views/AdminPanel.vue'), meta: { title: '热处理大屏后台' } }
]

const router = createRouter({
    history: createWebHistory(),
    routes
})

router.afterEach((to) => {
    document.title = to.meta?.title || '热处理数字孪生大屏'
})

export default router
