\ Distributed fuzzy fire detection (DC4CD section 5.2 on a UTXO chain)
\ Truth values are 0..1000. An opinion cell packs temp.high*65536 + smoke.high.
variable local
variable nsum

: unpack ( packed -- temp smoke ) dup 65536 / swap over 65536 * - ;
: opinion ( packed -- truth ) unpack min ;        \ fuzzy AND of the two memberships
: >= ( a b -- flag ) - $80000000 and 0= ;

yield
\ ---- local node (slot 0) measures
time 1760604800 - $80000000 and 0= if halt then   \ past the deadline: refund
536902912 in over over 0 sigverify swap drop opinion local !
yield

\ ---- neighbour 1 dispenses its opinion
time 1760604800 - $80000000 and 0= if halt then   \ past the deadline: refund
536902913 in over over 1 sigverify swap drop opinion
nsum @ + nsum !
yield

\ ---- neighbour 2 dispenses its opinion
time 1760604800 - $80000000 and 0= if halt then   \ past the deadline: refund
536902914 in over over 2 sigverify swap drop opinion
nsum @ + nsum !
yield

\ ---- rule: fire.high = local AND average(neighbourhood)
nsum @ 2 / local @ min
dup out
500 >= if 1 out 1000 bounty else 0 out then
halt
