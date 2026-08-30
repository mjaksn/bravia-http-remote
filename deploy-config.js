/* Placeholder. Leave it as it is and the console behaves normally: it
   asks for a hostname and a pre-shared key on first run and remembers
   them in localStorage.

   To deploy a preconfigured, password-protected copy instead, open
   pack.html, fill in the address, the key and a password, and replace
   this file with what it produces. The page then starts locked and asks
   for that password rather than for the connection details, on every
   browser that has not been told to stay signed in.

   See "Deploying a locked copy" in README.md. */

window.BRAVIA_DEPLOY_CONFIG = null;

/* Cards this copy of the console should never draw, named by the part of
   an element id that follows "card-". Empty is the ordinary case: the
   console shows everything the display turns out to support.

       window.BRAVIA_HIDDEN_CARDS = ['apps', 'keys'];

   leaves out Apps and Remote Keys, and nothing in the console offers them
   back; this file is the only place the choice is made. The names, in the
   order the page lays them out, are:

       power  playing  volume  inputs  apps  keys  text  picture  sound
       system  speaker

   A name that matches no card is passed over, so a typo shows up as a
   card that is still there rather than as a page that will not load.

   Edit the list here and reload. A file written by pack.html or seal.py
   carries its own list instead, sealed alongside the address and the key;
   both are honoured, and neither is a lock. A card left out is one the
   display would still obey if it were asked another way.

   See "Leaving cards out" in README.md. */

window.BRAVIA_HIDDEN_CARDS = [];
