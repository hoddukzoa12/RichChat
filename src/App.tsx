import { useBreakpoint } from './hooks/useBreakpoint'
import { InboxProvider, useInbox } from './state/InboxContext'
import { ChatPane } from './components/ChatPane'
import { ConversationList } from './components/ConversationList'
import { CustomerCard } from './components/card/CustomerCard'
import { MySettings } from './components/MySettings'
import { OfficeSettings } from './components/OfficeSettings'
import { MobileTabBar, Rail } from './components/Rail'
import { Toast } from './components/Toast'
import { AuthGate } from './api/AuthGate'

function Workspace() {
  const { state } = useInbox()
  const breakpoint = useBreakpoint()
  const mobile = breakpoint === 'mobile'

  const showList = !mobile || state.mobileView === 'list'
  const showChat = !mobile || state.mobileView === 'chat'

  return (
    <div className="w-full h-screen min-w-[360px] min-h-[560px] flex bg-white overflow-hidden relative text-sm leading-normal">
      {!mobile && <Rail />}

      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex-1 min-h-0 flex overflow-hidden relative">
          {state.page === 'chat' && (
            <>
              {showList && <ConversationList breakpoint={breakpoint} />}
              {showChat && <ChatPane breakpoint={breakpoint} />}
              {state.cardOpen && showChat && <CustomerCard breakpoint={breakpoint} />}
            </>
          )}
          {state.page === 'office' && <OfficeSettings />}
          {state.page === 'settings' && <MySettings />}
        </div>

        {mobile && <MobileTabBar />}
      </div>

      <Toast breakpoint={breakpoint} />
    </div>
  )
}

export default function App() {
  return (
    <AuthGate>
      <InboxProvider>
        <Workspace />
      </InboxProvider>
    </AuthGate>
  )
}
