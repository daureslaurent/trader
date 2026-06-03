interface TradeApprovalProps {
  tradeId: number
  coin: string
  side: string
  quantity: number
  reason: string
  confidence: number
  onApprove: (id: number) => void
  onReject: (id: number) => void
}

export default function TradeApproval({
  tradeId, coin, side, quantity, reason, confidence, onApprove, onReject,
}: TradeApprovalProps) {
  return (
    <div className="border border-yellow-500/30 bg-yellow-950/20 rounded-lg p-4 mb-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-yellow-400 font-bold">⚠ Approval Needed</span>
        <span className="text-sm text-gray-400">#{tradeId}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-sm mb-3">
        <div><span className="text-gray-400">Action:</span> <span className={side === 'BUY' ? 'text-green-400' : 'text-red-400'}>{side}</span></div>
        <div><span className="text-gray-400">Coin:</span> {coin}</div>
        <div><span className="text-gray-400">Qty:</span> {quantity}</div>
        <div><span className="text-gray-400">Confidence:</span> {(confidence * 100).toFixed(0)}%</div>
      </div>
      <p className="text-sm text-gray-300 mb-3">{reason}</p>
      <div className="flex gap-2">
        <button onClick={() => onApprove(tradeId)} className="px-4 py-1.5 bg-green-600 hover:bg-green-500 rounded text-sm font-medium">Approve</button>
        <button onClick={() => onReject(tradeId)} className="px-4 py-1.5 bg-red-600 hover:bg-red-500 rounded text-sm font-medium">Reject</button>
      </div>
    </div>
  )
}
