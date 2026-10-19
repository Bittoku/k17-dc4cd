\ bridge-mote.fs -- DC4CD words for the bridge mote of a k17forth gateway.
\
\ The bridge mote is connected to the gateway computer by a serial line.
\ The gateway reads one line for each reading, in this form:
\
\     R <reading>
\
\ The reading is a decimal number. It must be in the unsigned cell range
\ (0 to 4294967295). The word TEMPERATURE must give the reading with its
\ offset already added, for example tenths of a degree plus 5000.
\ The gateway ignores all other lines.

\ >GATEWAY sends one reading to the gateway on the serial line.
\ Stack: ( n -- ). Output: "R ", then n, then a new line.
: >gateway ( n -- )  ." R " . cr ;

\ REPORT reads the sensor and sends the reading to the gateway.
: report ( -- )  temperature >gateway ;

\ The sponsor sends the line below to make the nodes report one time in
\ each period. Use the period of the consortium machine, in seconds
\ ([consortium] period in the gateway config). This example uses 600.
\
\ ALL is the broadcast destination, and EVERY ( xt seconds -- ) runs a
\ word again and again with that interval. Use the names that your DC4CD
\ build has for these two words.
\
\     all tell: ' report 600 every :tell
