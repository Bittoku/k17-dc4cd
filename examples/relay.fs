\ Roster-attested aggregation relay (DC4CD section 5.1 on a UTXO chain)
\ Generated for hops=3 epoch=1000 deadline=1760604800
variable sum
variable lo
variable hi

: accumulate ( reading -- )
  dup sum @ + sum !
  dup lo @ min lo !
  hi @ max hi ! ;

$ffffffff lo !          \ running minimum starts at the top of the range
yield                   \ deployment cycle ends here; hop 0 is the next transaction

\ ---- hop 0: roster slot 0 attests (epoch+0, reading)
time 1760604800 - $80000000 and 0= if halt then   \ past the deadline: refund
1000 in over over 0 sigverify swap drop  \ ( reading )
150 bounty
accumulate
yield

\ ---- hop 1: roster slot 1 attests (epoch+1, reading)
time 1760604800 - $80000000 and 0= if halt then   \ past the deadline: refund
1001 in over over 1 sigverify swap drop  \ ( reading )
150 bounty
accumulate
yield

\ ---- hop 2: roster slot 2 attests (epoch+2, reading)
time 1760604800 - $80000000 and 0= if halt then   \ past the deadline: refund
1002 in over over 2 sigverify swap drop  \ ( reading )
150 bounty
accumulate
yield

\ ---- retrieval: the output log is the message to the ancestor
3 out
sum @ out
sum @ 3 / out
lo @ out
hi @ out
halt
