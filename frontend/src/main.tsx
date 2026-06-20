import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { installFetchInterceptor } from './lib/auth'

// Patch fetch before anything renders so every API call carries the auth token
// and reacts to 401s. Must run before the first request fires.
installFetchInterceptor()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
)
