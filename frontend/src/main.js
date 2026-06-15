import { createApp, h, defineComponent } from 'vue'
import './style.css'
import router from './router/index.js'
import { RouterView } from 'vue-router'

const RootApp = defineComponent({
    render() {
        return h(RouterView)
    }
})

const app = createApp(RootApp)
app.use(router)
app.mount('#app')
